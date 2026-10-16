import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { startSchedule } from './runtime.mjs';
import { startScheduleForBrowser } from './release-runtime.mjs';
import { browserCustody } from './browser-custody.mjs';
import { createHash } from 'node:crypto';
import { describeFailure, publishGroup, safeFailure, writeSafeJson } from './artifact-safety.mjs';

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
await mkdir(resolve('.e2e'), { recursive: true });
const privateRoot = await mkdtemp(join(resolve('.e2e'), 'private-artifacts-'));
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { mode: 0o700 });
let cancelled = false;
const cancel = () => { cancelled = true; process.exitCode = 1; };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);

async function cli(command, env, timeout = 900000) {
  const custody = command[0] === 'run' && browser !== 'chromium'
    ? await browserCustody(resolve(root, '.e2e'), browser) : undefined;
  const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', ...command], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
      DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      ...custody?.env, ...env },
  });
  let stdout = '', stderr = '', interrupted = false, hardStop, browserEvidence, primary;
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
    return { code: interrupted ? 1 : code, stdout, stderr,
      ...(custody ? { browserCustody: browserEvidence = await custody.finish(stdout + stderr) } : {}) };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    clearTimeout(timer); clearTimeout(hardStop);
    if (child.pid) signal('SIGKILL');
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (custody) {
      const cleanup = [];
      try {
        browserEvidence ??= await custody.finish(stdout + stderr);
        await writeFile(join(env.SCHEDULE_E2E_OUTPUT, 'browser-custody.json'), JSON.stringify(browserEvidence, null, 2) + '\n', { mode: 0o600 });
        if (primary && browserEvidence.errors.length) throw new Error('Browser custody failed after child failure');
      } catch (error) { cleanup.push(error); }
      if (cleanup.length) throw new AggregateError(primary ? [primary, ...cleanup] : cleanup, 'Child and browser custody failures');
    }
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
  const privateVariant = join(privateRoot, variant);
  await mkdir(privateVariant);
  const env = { SCHEDULE_E2E_BROWSER: browser, SCHEDULE_E2E_MOBILE: variant === 'mobile' ? '1' : '' };
  try {
    const discover = async filters => {
      const result = await cli(['list', '--reporter', 'json', ...filters], { ...env, SCHEDULE_E2E_OUTPUT: privateVariant }, 30000);
      if (filters.length && result.code === 2 && /^NO_TESTS: \d+ tests were collected but none is runnable:/.test(result.stderr)) {
        throw new Error('Zero selected tests');
      }
      assert.equal(result.code, 0, `Framework discovery failed: ${(result.stderr || result.stdout).slice(0, 1200)}`);
      return JSON.parse(result.stdout).pairs.filter(pair => pair.kind === 'test' && pair.disposition === 'run');
    };
    const all = await discover([]), selected = args.length ? await discover(args) : all;
    await writeSafeJson(join(variantDirectory, 'discovery.json'), { all, selected }, privateRoot);
    assert.ok(selected.length, 'Zero selected tests');
    assert.ok(selected.every(pair => all.some(known => known.id === pair.id)));
    variantEvidence.expectedIds = ids(selected);
    for (const pair of selected) {
      assert.equal(cancelled, false, 'Run interrupted before starting another isolated journey');
      const directory = join(privateVariant, pair.id.slice(0, 12));
      const destination = join(variantDirectory, pair.id.slice(0, 12));
      await mkdir(directory, { recursive: true });
      const evidence = { test: pair.title, expectedIds: [pair.id], cleanup: 'not-started', status: 'failed', errors: [] };
      let runtime, published;
      let phase = 'startup';
      try {
        runtime = await (browser === 'webkit' ? startScheduleForBrowser : startSchedule)({ authDirectory: process.env.SCHEDULE_AUTH_DIRECTORY || resolve(root, '.e2e/deps/auth'),
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
        phase = 'child';
        const result = await cli(['run', '--grep', `^${escapePattern(pair.title)}$`], { ...env,
          SCHEDULE_E2E_OUTPUT: directory, SCHEDULE_E2E_URL: runtime.origin,
          SCHEDULE_AUTH_URL: runtime.authOrigin, SCHEDULE_E2E_CONTROL: runtime.controlOrigin,
          SCHEDULE_SCHOOL_CONTROL: runtime.schoolOrigin,
          ...runtime.browserEnvironment,
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
        if (result.browserCustody) {
          assert.deepEqual(result.browserCustody.errors, [], 'Browser custody cleanup failed');
          for (const key of ['headless', 'engineBinary', 'browserExited', 'profileRemoved', 'privateHomeRemoved']) {
            assert.equal(result.browserCustody[key], true, `Browser custody ${key}`);
          }
        }
        assert.equal(result.code, 0, 'E2E child failed');
        assert.equal(report.run.status, 'passed');
        assert.equal(executed.some(test => test.attempts?.some(attempt => attempt.cleanup === 'failed' ||
          attempt.secondaryErrors?.some(error => error.phase === 'cleanup'))), false, 'Browser cleanup failed in framework attempt evidence');
        for (const key of ['failed', 'interrupted', 'skipped', 'flaky']) assert.equal(report.run.summary[key], 0, key);
      } catch (error) { evidence.errors.push(describeFailure(error, phase)); }
      finally {
        if (runtime) {
          try { evidence.diagnostics = await runtime.diagnostics(); }
          catch (error) { evidence.errors.push(describeFailure(error, 'diagnostics')); }
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
          } catch (error) { evidence.cleanup = 'failed'; evidence.errors.push(describeFailure(error, 'cleanup')); }
        }
        if (!evidence.errors.length) evidence.status = 'passed';
        published = await publishGroup({ directory, destination, evidence, runtime, privateRoot });
        variantEvidence.groups.push(published);
        console.log(`${variant}: ${pair.title}: ${evidence.status}; cleanup ${evidence.cleanup}`);
      }
      if (published.status !== 'passed') throw new Error(`Journey failed; evidence ${destination}`);
    }
    assert.deepEqual(variantEvidence.executedIds.sort(), variantEvidence.expectedIds, 'Incomplete suite');
    variantEvidence.status = 'passed';
  } catch (error) {
    const failure = describeFailure(error, 'child');
    variantEvidence.errors.push(safeFailure(failure)); process.exitCode = 1;
    try { await writeFile(join(privateRoot, variant + '-failure.json'), JSON.stringify(failure, null, 2) + '\n', { mode: 0o600 }); }
    catch (writeError) { variantEvidence.errors.push(safeFailure(describeFailure(writeError, 'private-write'))); }
  }
  try { await writeSafeJson(join(variantDirectory, 'run.json'), variantEvidence, privateRoot); }
  catch (error) {
    process.exitCode = 1;
    console.error(JSON.stringify({ status: 'failed', errors: [...variantEvidence.errors, safeFailure(describeFailure(error, 'receipt-write'))] }));
  }
  console.log(`${variant}: ${variantEvidence.status}; evidence ${variantDirectory}`);
  if (process.exitCode) break;
}
process.removeListener('SIGINT', cancel);
process.removeListener('SIGTERM', cancel);
