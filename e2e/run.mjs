import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startSchedule } from './runtime.mjs';
import { createHash } from 'node:crypto';

const root = process.cwd();
const output = resolve(process.env.SCHEDULE_E2E_OUTPUT || `.e2e/run-${Date.now()}`);
assert.ok(output.startsWith(resolve('.e2e') + '/'), 'Evidence must stay under .e2e');
const viewport = process.env.SCHEDULE_E2E_VIEWPORT || (process.env.SCHEDULE_E2E_MOBILE ? 'mobile' : 'all');
assert.ok(['all', 'desktop', 'mobile'].includes(viewport), 'Unknown E2E viewport');
const browser = process.env.SCHEDULE_E2E_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(browser), 'Unknown E2E browser');
const variants = viewport === 'all' ? ['desktop', 'mobile'] : [viewport];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--grep', '--grep-invert'].includes(args[index]) && args[index + 1],
    'This required gate accepts title filters only; browser visibility, retries and zero-test overrides are forbidden');
}
const dependency = JSON.parse(await readFile(join(root, 'e2e/auth-dependency.json'), 'utf8'));
const describe = error => ({ name: error.name, message: error.message,
  ...(error instanceof AggregateError ? { errors: error.errors.map(describe) } : {}) });
let cancelled = false;
const cancel = () => { cancelled = true; process.exitCode = 1; };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

async function cli(command, env, timeout = 900000) {
  const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', ...command], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
      DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, ...env },
  });
  let stdout = '', stderr = '', interrupted = false, hardStop;
  const signal = name => {
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    signal('SIGTERM');
    hardStop = setTimeout(() => signal('SIGKILL'), 5000);
  };
  const timer = setTimeout(stop, timeout);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done(signal ? 1 : code));
    });
    return { code: interrupted ? 1 : code, stdout, stderr };
  } finally {
    clearTimeout(timer); clearTimeout(hardStop);
    if (child.pid) signal('SIGKILL');
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

const sourceFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const sourceHash = createHash('sha256');
for (const file of sourceFiles) {
  try { sourceHash.update(file + '\0').update(await readFile(join(root, file))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), fingerprint: sourceHash.digest('hex') };
const ids = pairs => pairs.map(pair => pair.id).sort();
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const variant of variants) {
  const variantDirectory = join(output, variant);
  await mkdir(variantDirectory, { recursive: true });
  const variantEvidence = { variant, browser, source, status: 'failed', expectedIds: [], executedIds: [], groups: [], errors: [] };
  const env = { SCHEDULE_E2E_BROWSER: browser, SCHEDULE_E2E_MOBILE: variant === 'mobile' ? '1' : '' };
  try {
    const discover = async filters => {
      const result = await cli(['list', '--reporter', 'json', ...filters], { ...env, SCHEDULE_E2E_OUTPUT: variantDirectory }, 30000);
      assert.equal(result.code, 0, `Framework discovery failed: ${(result.stderr || result.stdout).slice(0, 1200)}`);
      return JSON.parse(result.stdout).pairs.filter(pair => pair.kind === 'test' && pair.disposition === 'run');
    };
    const all = await discover([]), selected = args.length ? await discover(args) : all;
    await writeFile(join(variantDirectory, 'discovery.json'), JSON.stringify({ all, selected }, null, 2));
    assert.ok(selected.length, 'Zero selected tests');
    assert.ok(selected.every(pair => all.some(known => known.id === pair.id)));
    variantEvidence.expectedIds = ids(selected);
    for (const pair of selected) {
      assert.equal(cancelled, false, 'Run interrupted before starting another isolated journey');
      const directory = join(variantDirectory, pair.id.slice(0, 12));
      await mkdir(directory, { recursive: true });
      const evidence = { test: pair.title, expectedIds: [pair.id], cleanup: 'not-started', status: 'failed', errors: [] };
      variantEvidence.groups.push(evidence);
      let runtime;
      try {
        runtime = await startSchedule({ authDirectory: process.env.SCHEDULE_AUTH_DIRECTORY || resolve(root, '.e2e/deps/auth'),
          authCommit: process.env.SCHEDULE_AUTH_COMMIT || dependency.commit,
          external: pair.tags.includes('external'),
          directory: pair.tags.includes('directory'),
          lifecycleProfile: pair.tags.find(tag => tag.startsWith('lifecycle:'))?.slice(10),
          ...(pair.tags.includes('external-disabled') ? { sourceTypes: '' } : {}),
          accountNames: pair.tags.filter(tag => tag.startsWith('account:')).map(tag => tag.slice(8)) });
        assert.equal(cancelled, false, 'Run interrupted during startup');
        evidence.authCommit = runtime.authCommit;
        evidence.cleanup = 'pending';
        // User filters already chose the discovered pairs. Repeating --grep
        // would OR them with this exact group and break runtime isolation.
        const result = await cli(['run', '--grep', `^${escapePattern(pair.title)}$`], { ...env,
          SCHEDULE_E2E_OUTPUT: directory, SCHEDULE_E2E_URL: runtime.origin,
          SCHEDULE_AUTH_URL: runtime.authOrigin, SCHEDULE_E2E_CONTROL: runtime.controlOrigin,
          SCHEDULE_SCHOOL_CONTROL: runtime.schoolOrigin,
          SCHEDULE_E2E_BREAK_ASSERTION: process.env.SCHEDULE_E2E_BREAK_ASSERTION || '' });
        await writeFile(join(directory, 'runner.log'), result.stdout + result.stderr);
        const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
        const tests = report.run.results.filter(test => test.kind === 'test');
        const executed = tests.filter(test => test.selected && test.status !== 'skipped');
        assert.deepEqual(ids(tests), ids(all), 'Report discovery differs from framework list');
        assert.deepEqual(ids(tests.filter(test => test.selected)), [pair.id], 'Selection escaped its isolated runtime');
        assert.deepEqual(ids(executed), [pair.id], 'Required test was not executed');
        variantEvidence.executedIds.push(...ids(executed));
        evidence.summary = report.run.summary;
        evidence.runnerExitCode = result.code;
        assert.equal(result.code, 0, 'E2E child failed');
        assert.equal(report.run.status, 'passed');
        assert.equal(executed.some(test => test.attempts?.some(attempt => attempt.cleanup === 'failed' ||
          attempt.secondaryErrors?.some(error => error.phase === 'cleanup'))), false, 'Browser cleanup failed in framework attempt evidence');
        for (const key of ['failed', 'interrupted', 'skipped', 'flaky']) assert.equal(report.run.summary[key], 0, key);
      } catch (error) { evidence.errors.push(describe(error)); }
      finally {
        if (runtime) {
          try { evidence.diagnostics = await runtime.diagnostics(); }
          catch (error) { evidence.errors.push(describe(error)); }
          try {
            evidence.resources = await runtime.close();
            assert.equal(evidence.resources.platform?.proxyObjectsRemoved, true, 'Native egress proxy cleanup was not verified');
            const proxies = evidence.resources.platform.removedProxyIds;
            assert.ok(Array.isArray(proxies) && proxies.every(id => /^[a-f0-9]{64}$/.test(id)), 'Missing actual removed proxy IDs');
            if (pair.tags.some(tag => tag.startsWith('lifecycle:'))) assert.ok(proxies.length > 0, 'Bound lifecycle journey must remove its actual native proxy');
            for (const id of [...proxies, ...evidence.resources.platform.removedContainerIds]) {
              assert.match(id, /^[a-f0-9]{64}$/);
              assert.equal(execFileSync('docker', ['ps', '-aq', '--no-trunc', '--filter', `id=${id}`], { encoding: 'utf8' }).trim(), '', 'An owned native object remains after cleanup');
            }
            evidence.resources.actualRemovedIdsVerified = true;
            if (process.env.SCHEDULE_E2E_FAIL_CLEANUP === '1') throw new Error('Injected cleanup failure after real resources stopped');
            evidence.cleanup = 'passed';
          } catch (error) { evidence.cleanup = 'failed'; evidence.errors.push(describe(error)); }
        }
        if (!evidence.errors.length) evidence.status = 'passed';
        const write = () => writeFile(join(directory, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
        await write();
        if (runtime) try {
          await runtime.checkArtifacts(directory);
          // Carry the sanitized group into the later aggregate; otherwise the
          // aggregate would reintroduce raw tokens from its in-memory copy.
          Object.assign(evidence, JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')));
        }
        catch (error) { evidence.status = 'failed'; evidence.errors.push(describe(error)); await write(); }
        console.log(`${variant}: ${pair.title}: ${evidence.status}; cleanup ${evidence.cleanup}`);
      }
      if (evidence.errors.length) throw new Error(`Journey failed; evidence ${directory}`);
    }
    assert.deepEqual(variantEvidence.executedIds.sort(), variantEvidence.expectedIds, 'Incomplete suite');
    variantEvidence.status = 'passed';
  } catch (error) { variantEvidence.errors.push(describe(error)); process.exitCode = 1; }
  await writeFile(join(variantDirectory, 'run.json'), JSON.stringify(variantEvidence, null, 2) + '\n');
  console.log(`${variant}: ${variantEvidence.status}; evidence ${variantDirectory}`);
  if (process.exitCode) break;
}
process.removeListener('SIGINT', cancel);
process.removeListener('SIGTERM', cancel);
