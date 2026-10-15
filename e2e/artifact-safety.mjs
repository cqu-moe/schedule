import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const textFile = name => /\.(json|md|log|txt)$/.test(name);
const phases = new Set(['startup', 'child', 'diagnostics', 'cleanup', 'artifacts', 'private-write', 'verified-read', 'publish', 'receipt-write']);
const groupKeys = ['test', 'expectedIds', 'cleanup', 'status', 'errors', 'authCommit', 'summary', 'runnerExitCode', 'diagnostics', 'resources'];

export function describeFailure(error, phase) {
  return { name: error.name, message: error.message, phase,
    ...(error instanceof AggregateError ? { errors: error.errors.map(nested => describeFailure(nested, phase)) } : {}),
    ...(/^[a-f0-9]{40}$/.test(error.actual) && /^[a-f0-9]{40}$/.test(error.expected)
      ? { actual: error.actual, expected: error.expected } : {}),
    ...(error.artifactDiagnostics ? { artifactDiagnostics: error.artifactDiagnostics } : {}) };
}

export function safeFailure(error) {
  const value = { name: 'Error', message: error.message === 'Zero selected tests' ? 'Zero selected tests' : 'E2E failure; raw details retained privately',
    phase: phases.has(error.phase) ? error.phase : 'artifacts', sha256: hash(JSON.stringify(error)) };
  if (/^[a-f0-9]{40}$/.test(error.actual) && /^[a-f0-9]{40}$/.test(error.expected)) {
    value.actual = error.actual; value.expected = error.expected;
  }
  if (error.errors) value.errors = error.errors.map(safeFailure);
  if (error.artifactDiagnostics) value.artifactDiagnostics = error.artifactDiagnostics.map(item => ({
    category: item.category === 'dependency-sensitive-check' ? item.category : 'artifact-check-error',
    file: ['report.json', 'runtime.json', 'runner.log', 'trace.md', 'screen-at-failure.txt'].includes(item.file) ? item.file : 'other-artifact',
    ...Object.fromEntries(['pathSha256', 'contentSha256'].filter(key => /^[a-f0-9]{64}$/.test(item[key])).map(key => [key, item[key]])),
    needle: 'not-exposed',
  }));
  return value;
}

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else { assert.ok(entry.isFile(), 'Artifacts must be regular files'); files.push(path); }
  }
  return files.sort();
}

export async function sanitizeArtifacts(directory, { redact, check, secrets, privateRoot }) {
  await redact(directory);
  for (const path of await filesIn(directory)) {
    if (!textFile(path)) continue;
    let text = await readFile(path, 'utf8');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[synthetic-secret-redacted]');
    text = text.replace(/([?&](?:code|state|nonce|sig|code_challenge)=)[^&\s"<>\\]+/g, '$1[synthetic-secret-redacted]');
    await writeFile(path, text);
  }
  const reportPath = join(directory, 'report.json');
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (report) {
    const artifactRoot = join(directory, 'results');
    async function update(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.path === 'string' && typeof value.sha256 === 'string' && typeof value.size === 'number') {
        const path = join(artifactRoot, value.path);
        assert.ok(relative(artifactRoot, path) && !relative(artifactRoot, path).startsWith('..'), 'Artifact must remain inside this run');
        const bytes = await readFile(path); value.size = bytes.length; value.sha256 = hash(bytes);
      }
      for (const nested of Object.values(value)) await update(nested);
    }
    await update(report);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  try { await check(directory); }
  catch (primary) {
    const errors = [primary], diagnostics = [];
    if (primary.message === 'Sensitive synthetic value found in E2E text artifacts') {
      let probe;
      try {
        probe = await mkdtemp(join(privateRoot, 'private-artifact-check-'));
        for (const path of await filesIn(directory)) {
          if (!textFile(path)) continue;
          const bytes = await readFile(path), sample = join(probe, 'sample.txt');
          await writeFile(sample, bytes, { mode: 0o600 });
          try { await check(probe); }
          catch (error) {
            if (error.message !== primary.message) throw error;
            diagnostics.push({ category: 'dependency-sensitive-check', file: basename(path),
              pathSha256: hash(relative(directory, path)), contentSha256: hash(bytes), needle: 'not-exposed' });
          }
          await rm(sample);
        }
      } catch (error) { errors.push(error); }
      finally { if (probe) try { await rm(probe, { recursive: true, force: true }); } catch (error) { errors.push(error); } }
    }
    throw Object.assign(errors.length === 1 ? primary : new AggregateError(errors, 'Artifact check and diagnostic cleanup failed'),
      { artifactDiagnostics: diagnostics });
  }
  const files = [];
  for (const path of await filesIn(directory)) {
    const bytes = await readFile(path);
    files.push({ path: relative(directory, path), bytes: bytes.length, sha256: hash(bytes) });
  }
  return { files };
}

export async function writeSafeJson(path, value, privateRoot) {
  const temporary = join(privateRoot, randomUUID() + '.json');
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await mkdir(dirname(path), { recursive: true });
  await rename(temporary, path);
}

function failureGroup(evidence) {
  return { test: evidence.test, expectedIds: evidence.expectedIds, status: 'failed',
    cleanup: ['passed', 'failed', 'not-started'].includes(evidence.cleanup) ? evidence.cleanup : 'failed',
    errors: evidence.errors.map(safeFailure), artifactSafety: 'quarantined',
    ...(/^[a-f0-9]{40}$/.test(evidence.authCommit) ? { authCommit: evidence.authCommit } : {}),
    ...(Number.isInteger(evidence.runnerExitCode) ? { runnerExitCode: evidence.runnerExitCode } : {}) };
}

export async function publishGroup({ directory, destination, evidence, runtime, privateRoot }) {
  let phase = 'private-write';
  try {
    await writeFile(join(directory, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    if (!runtime) throw new Error('No initialized runtime can validate artifacts');
    phase = 'artifacts';
    const manifest = await runtime.checkArtifacts(directory);
    phase = 'verified-read';
    const actualFiles = await filesIn(directory);
    assert.deepEqual(actualFiles.map(path => relative(directory, path)), manifest.files.map(file => file.path), 'Verified artifact set changed');
    for (const file of manifest.files) {
      const bytes = await readFile(join(directory, file.path));
      assert.equal(bytes.length, file.bytes, 'Verified artifact size changed');
      assert.equal(hash(bytes), file.sha256, 'Verified artifact bytes changed');
    }
    const bytes = await readFile(join(directory, 'runtime.json'));
    assert.equal(hash(bytes), manifest.files.find(file => file.path === 'runtime.json')?.sha256, 'Verified runtime bytes changed');
    const parsed = JSON.parse(bytes);
    assert.equal(parsed.test, evidence.test); assert.deepEqual(parsed.expectedIds, evidence.expectedIds);
    const verified = Object.fromEntries(groupKeys.filter(key => Object.hasOwn(parsed, key)).map(key => [key, parsed[key]]));
    phase = 'publish';
    await rename(directory, destination);
    return verified;
  } catch (error) {
    evidence.status = 'failed'; evidence.errors.push(describeFailure(error, phase));
  }
  // Only this projection can cross the upload boundary after an unverified group.
  // Raw primary/cleanup errors remain in a mode-0700 directory outside CI globs.
  try { await writeFile(join(directory, 'failure-private.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { evidence.errors.push(describeFailure(error, 'private-write')); }
  let safe = failureGroup(evidence);
  try { await writeSafeJson(join(destination, 'runtime.json'), safe, privateRoot); }
  catch (error) {
    evidence.errors.push(describeFailure(error, 'receipt-write'));
    try { await writeFile(join(directory, 'failure-private.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); }
    catch (writeError) { evidence.errors.push(describeFailure(writeError, 'private-write')); }
    safe = failureGroup(evidence);
  }
  return safe;
}
