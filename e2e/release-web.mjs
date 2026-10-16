import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describeFailure, safeFailure, writeSafeJson } from './artifact-safety.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const root = process.cwd();
const inventory = () => execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: 'pipe' })
  .split('\0').filter(Boolean).sort();
let privateRoot, output, receipt, child, cancelled = false;
const failures = [], manifest = [];
const cancel = () => { cancelled = true; child?.kill('SIGTERM'); };

async function remember(error, phase) {
  const failure = describeFailure(error, phase);
  failures.push(failure);
  process.exitCode = 1;
  if (privateRoot) {
    try {
      await writeFile(join(privateRoot, 'failure-private.json'), JSON.stringify({ failures,
        lastStack: error.stack }, null, 2) + '\n', { mode: 0o600 });
    } catch (writeError) { failures.push(describeFailure(writeError, 'private-write')); }
  }
}

async function run(browser, viewport, name, filters = [], fault = {}) {
  assert.equal(cancelled, false, 'Release execution interrupted');
  const directory = join(output, `${browser}-${name}`);
  const startedAt = new Date().toISOString();
  const log = await open(join(privateRoot, `${browser}-${name}.log`), 'wx', 0o600);
  let pending = Promise.resolve(), streamError, primary, result;
  try {
    child = spawn(process.execPath, ['e2e/run.mjs', ...filters], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        CI: process.env.CI, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
        SCHEDULE_E2E_BROWSER: browser, SCHEDULE_E2E_VIEWPORT: viewport,
        SCHEDULE_E2E_OUTPUT: directory, ...fault },
    });
    // This driver has no runtime secret registry. Its raw streams stay private;
    // native artifacts are scanned by the child before that owner publishes them.
    const capture = chunk => {
      pending = pending.then(() => log.writeFile(chunk)).catch(error => {
        streamError ??= error;
        child?.kill('SIGTERM');
      });
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    result = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
  } catch (error) { primary = error; }
  finally {
    child = undefined;
    await pending;
    try { await log.close(); } catch (error) {
      streamError = streamError ? new AggregateError([streamError, error], 'Private stream cleanup failed') : error;
    }
  }
  if (primary || streamError) throw new AggregateError([primary, streamError].filter(Boolean), 'Release child or private stream failed');
  const record = { browser, viewport, name, startedAt, endedAt: new Date().toISOString(),
    command: ['node', 'e2e/run.mjs', ...filters], fault, ...result, directory };
  receipt.records.push(record);
  await writeSafeJson(join(output, 'receipt.json'), receipt, privateRoot);
  assert.equal(result.signal, null, 'A signal is not an intended control failure');
  const report = JSON.parse(await readFile(join(directory, viewport, 'run.json'), 'utf8'));
  assert.equal(report.source.fingerprint, receipt.source.fingerprint, 'Source changed between release entry and child');
  for (const group of report.groups) {
    assert.notEqual(group.artifactSafety, 'quarantined', 'Native artifacts were quarantined; inspect the private owner journal');
    assert.notEqual(group.runnerExitCode, undefined, 'Child failed before a readable framework attempt');
    const native = JSON.parse(await readFile(join(directory, viewport, group.expectedIds[0].slice(0, 12), 'report.json'), 'utf8'));
    const selected = native.run.results.filter(test => test.kind === 'test' && test.selected);
    assert.equal(selected.length, 1);
    assert.deepEqual(selected.map(test => test.id), group.expectedIds);
    assert.equal(selected[0].attempts.length, 1, 'No retries in a required release attempt');
    assert.equal(selected[0].attempts[0].index, 0);
    assert.equal(selected[0].attempts[0].cleanup, 'complete');
    assert.deepEqual(selected[0].attempts[0].secondaryErrors, []);
  }
  return { record, report };
}

try {
  await mkdir(resolve('.e2e'), { recursive: true });
  privateRoot = await mkdtemp(resolve('.e2e/private-release-'));
  const selfCheck = process.argv[2] === '--self-check';
  assert.deepEqual(process.argv.slice(2), selfCheck ? ['--self-check'] : []);
  output = resolve(process.env.SCHEDULE_RELEASE_OUTPUT || `.e2e/release-web-${Date.now()}`);
  assert.ok(output.startsWith(resolve('.e2e') + '/'), 'Evidence must stay under .e2e');
  await mkdir(output, { mode: 0o700 }); // Never overwrite an earlier attempt.
  const digest = createHash('sha256');
  for (const path of inventory()) {
    const bytes = await readFile(path);
    digest.update(path + '\0').update(bytes);
    manifest.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(),
    fingerprint: digest.digest('hex'), files: manifest };
  receipt = { mode: selfCheck ? 'controls' : 'full-round', source, records: [], status: 'running', privateEvidenceRoot: privateRoot };
  await writeSafeJson(join(output, 'receipt.json'), receipt, privateRoot);
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  for (const browser of ['firefox', 'webkit']) {
    if (selfCheck) {
      const zero = await run(browser, 'desktop', 'zero', ['--grep', '^SCHEDULE_RELEASE_ZERO_SELECTION$']);
      assert.equal(zero.record.code, 1);
      assert.deepEqual(zero.report.groups, []);
      assert.deepEqual(zero.report.errors.map(error => error.message), ['Zero selected tests']);
      const assertion = await run(browser, 'desktop', 'assertion', ['--grep', '^login, create'], { SCHEDULE_E2E_BREAK_ASSERTION: '1' });
      assert.equal(assertion.record.code, 1);
      assert.equal(assertion.report.groups[0].summary.failed, 1);
      assert.equal(assertion.report.groups[0].cleanup, 'passed');
      const native = JSON.parse(await readFile(join(assertion.record.directory, 'desktop',
        assertion.report.groups[0].expectedIds[0].slice(0, 12), 'report.json'), 'utf8'));
      const attempt = native.run.results.find(test => test.selected).attempts[0];
      assert.equal(attempt.error.code, 'ASSERTION_FAILED');
      assert.ok(JSON.stringify(attempt.error).includes('故意错误的课程内容'));
      const cleanup = await run(browser, 'desktop', 'cleanup', ['--grep', '^no-sync:'], { SCHEDULE_E2E_FAIL_CLEANUP: '1' });
      assert.equal(cleanup.record.code, 1);
      assert.equal(cleanup.report.groups[0].summary.passed, 1);
      assert.equal(cleanup.report.groups[0].cleanup, 'failed');
      assert.ok(JSON.stringify(cleanup.report.groups[0].errors).includes('Injected cleanup failure after real resources stopped'));
      assert.equal(cleanup.report.groups[0].resources.actualRemovedIdsVerified, true);
    } else {
      for (const viewport of ['desktop', 'mobile']) {
        const { record, report } = await run(browser, viewport, viewport);
        assert.equal(record.code, 0);
        assert.equal(report.status, 'passed');
        assert.equal(report.expectedIds.length, 31);
        assert.deepEqual([...report.executedIds].sort(), [...report.expectedIds].sort());
        assert.equal(report.groups.length, 31);
        for (const group of report.groups) {
          assert.equal(group.status, 'passed'); assert.equal(group.cleanup, 'passed');
          assert.equal(group.summary.passed, 1); assert.deepEqual(group.errors, []);
          const directory = join(record.directory, viewport, group.expectedIds[0].slice(0, 12));
          const custody = JSON.parse(await readFile(join(directory, 'browser-custody.json'), 'utf8'));
          assert.deepEqual(custody.errors, []);
          for (const key of ['headless', 'engineBinary', 'browserExited', 'profileRemoved', 'privateHomeRemoved']) assert.equal(custody[key], true);
          if (browser === 'webkit') {
            const tls = group.diagnostics.tls;
            assert.ok(tls.observations.some(item => item.path === '/api/v2/config' && item.status === 200));
            // This original platform-only case has a real browser beforeEach,
            // but its body intentionally never logs in. All other owners do.
            const platformOnly = group.test === 'legacy teacher harvesting and expired directory runs terminate without school bulk calls';
            const callback = tls.observations.find(item => item.path === '/callback' && item.status === 302);
            if (platformOnly) assert.equal(callback, undefined);
            else {
              assert.ok(callback?.requestCookieNames.includes('__Host-schedule_login'), 'Real HTTPS callback did not return the Secure login cookie');
              assert.ok(tls.observations.some(item => item.setCookies.some(cookie => cookie.name === '__Host-schedule_login' && cookie.secure && cookie.httpOnly)));
            }
            for (const key of ['listenerClosed', 'certificateMaterialRemoved', 'privateMaterialRootRemoved']) assert.equal(group.resources.tls[key], true);
            const names = await readdir(directory);
            assert.ok(names.filter(name => /^tls-context-\d+\.json$/.test(name)).length >= 2, 'Both CLI and actual worker must load the bounded TLS adapter');
          }
        }
      }
    }
  }
  receipt.status = 'passed';
} catch (error) { await remember(error, 'child'); }
finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if (manifest.length) {
    try {
      assert.deepEqual(inventory(), manifest.map(item => item.path), 'Source file set changed during execution');
      for (const item of manifest) assert.equal(hash(await readFile(item.path)), item.sha256, 'Source changed during release execution');
    } catch (error) { await remember(error, 'verified-read'); }
  }
  if (receipt) {
    if (failures.length) { receipt.status = 'failed'; receipt.errors = failures.map(safeFailure); }
    try { await writeSafeJson(join(output, 'receipt.json'), receipt, privateRoot); }
    catch (error) { await remember(error, 'receipt-write'); }
  }
  // Never log raw exceptions or child output, including admission/finalizer failures.
  console.log(JSON.stringify({ scope: 'Schedule release', status: failures.length ? 'failed' : receipt?.status,
    completedCells: receipt?.records.length ?? 0, errors: failures.map(safeFailure) }));
}
