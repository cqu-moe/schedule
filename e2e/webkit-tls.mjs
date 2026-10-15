import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { webkit } from 'playwright-core';
import { startSchedule } from './runtime.mjs';
import { holdLoopbackPort, startLocalTlsProxy, preserveFailures, describeError, verifyStockTlsFailure } from './local-tls.mjs';

const root = process.cwd();
const mode = process.env.SCHEDULE_WEBKIT_TLS_MODE || 'supplemental';
const viewportName = process.env.SCHEDULE_WEBKIT_TLS_VIEWPORT || 'desktop';
assert.ok(['stock-red', 'supplemental'].includes(mode), 'Unknown WebKit TLS probe mode');
assert.ok(['desktop', 'mobile'].includes(viewportName), 'Unknown WebKit TLS viewport');
const output = resolve(process.env.SCHEDULE_WEBKIT_TLS_OUTPUT || `.e2e/webkit-tls-${mode}-${viewportName}`);
assert.ok(output.startsWith(resolve('.e2e') + '/'), 'Evidence must stay under .e2e');
await mkdir(output, { recursive: true });
const viewport = viewportName === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const title = 'external search external_forbidden: real school failure is visible and an explicit retry can recover';
const ownerEmail = 'owner@example.test';
const ownerPassword = 'Synthetic-only-123!';

const sourceFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).sort();
const digest = createHash('sha256');
for (const file of sourceFiles) {
  try { digest.update(file + '\0').update(await readFile(join(root, file))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const changedFiles = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const untrackedFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  fingerprint: digest.digest('hex'),
  changedFiles: [...changedFiles, ...untrackedFiles],
};
assert.ok(source.changedFiles.every(file => file.startsWith('e2e/')), 'This ticket may only change E2E infrastructure');

const dependency = JSON.parse(await readFile(join(root, 'e2e/auth-dependency.json'), 'utf8'));
const receipt = {
  schemaVersion: 'schedule-webkit-tls-1',
  mode,
  viewportName,
  viewport,
  source,
  title,
  status: 'failed',
  cleanup: { status: 'pending' },
};

async function verifyRuntimeCleanup(runtime) {
  const errors = [];
  let diagnostics, resources;
  try { diagnostics = await runtime.diagnostics(); } catch (error) { errors.push(error); }
  try {
    resources = await runtime.close();
    assert.equal(resources.platform?.proxyObjectsRemoved, true, 'Native egress proxy cleanup was not verified');
    const proxies = resources.platform.removedProxyIds;
    assert.ok(Array.isArray(proxies) && proxies.length > 0 && proxies.every(id => /^[a-f0-9]{64}$/.test(id)),
      'Missing actual removed native proxy IDs');
    for (const id of [...proxies, ...resources.platform.removedContainerIds]) {
      assert.match(id, /^[a-f0-9]{64}$/);
      assert.equal(execFileSync('docker', ['ps', '-aq', '--no-trunc', '--filter', `id=${id}`], { encoding: 'utf8' }).trim(), '',
        'An owned native object remains after cleanup');
    }
    resources.actualRemovedIdsVerified = true;
  } catch (error) { errors.push(error); }
  receipt.diagnostics = diagnostics;
  receipt.resources = resources;
  if (errors.length) throw preserveFailures(null, errors, 'Schedule diagnostics or cleanup failed');
}

function childEnvironment({ runtime, proxy, directory }) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: process.env.CI,
    DO_NOT_TRACK: '1',
    E2E_TELEMETRY_DISABLED: '1',
    WRANGLER_SEND_METRICS: 'false',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    SCHEDULE_E2E_OUTPUT: directory,
    SCHEDULE_E2E_URL: proxy.origin,
    SCHEDULE_E2E_BROWSER: 'webkit',
    SCHEDULE_E2E_MOBILE: viewportName === 'mobile' ? '1' : '',
    SCHEDULE_AUTH_URL: runtime.authOrigin,
    SCHEDULE_E2E_CONTROL: runtime.controlOrigin,
    SCHEDULE_SCHOOL_CONTROL: runtime.schoolOrigin,
    SCHEDULE_E2E_BREAK_ASSERTION: '',
  };
}

async function installWebKit() {
  await new Promise((done, fail) => execFile(process.execPath,
    ['node_modules/@e2e-dev/web/dist/bin.js', 'install', 'webkit'],
    { cwd: root }, (error, stdout, stderr) => error ? fail(Object.assign(error, { stdout, stderr })) : done({ stdout, stderr })));
}

async function runStockEngine(runtime, proxy) {
  const directory = join(output, 'stock-engine');
  await mkdir(directory, { recursive: true });
  const filter = `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const env = childEnvironment({ runtime, proxy, directory });
  const discovery = JSON.parse(execFileSync(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'list',
    '--reporter', 'json', '--grep', filter], { cwd: root, env, encoding: 'utf8' }));
  const selected = discovery.pairs.filter(pair => pair.kind === 'test' && pair.disposition === 'run');
  assert.equal(selected.length, 1, 'Stock TLS control must select exactly one test');
  const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', '--grep', filter], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 180000);
  try {
    const { code, signal } = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => done({ code: exitCode, signal }));
    });
    await writeFile(join(directory, 'runner.log'), stdout + stderr);
    let report = null;
    try { report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const facts = { report, runnerExitCode: code, signal, timedOut, expectedId: selected[0].id,
      title, targetId: viewportName, origin: proxy.origin };
    receipt.stockEngine = { runnerExitCode: code, signal, timedOut, expectedId: selected[0].id, reportPath: join(directory, 'report.json') };
    return verifyStockTlsFailure(facts);
  } finally {
    clearTimeout(timer);
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

async function runSupplementalJourney(runtime, proxy) {
  const profiles = join(output, '.profiles');
  await mkdir(profiles, { recursive: true });
  const profile = await mkdtemp(join(profiles, 'webkit-'));
  const allowed = [proxy.origin, runtime.authOrigin];
  const unexpected = [];
  const externalRequests = [];
  const consoleEntries = [];
  const ownerResponses = [];
  const steps = [];
  let context;
  let page;
  const failure = {};
  let primaryError;
  const step = async (label, action) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const record = { label, startedAt, status: 'failed' };
    steps.push(record);
    try {
      await action();
      record.status = 'passed';
      record.durationMs = Date.now() - started;
    } catch (error) {
      record.durationMs = Date.now() - started;
      record.error = describeError(error);
      throw error;
    }
  };

  async function school(changes) {
    const response = await fetch(`${runtime.controlOrigin}/school?account=owner`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes),
    });
    assert.equal(response.status, 200, 'School control request failed');
    return response.json();
  }

  try {
    context = await webkit.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
      viewport,
    });
    page = context.pages()[0] ?? await context.newPage();
    page.on('console', message => consoleEntries.push({ type: message.type(), text: message.text().slice(0, 1000) }));
    context.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === proxy.origin && ['/api/v2/me', '/api/v2/subscriptions', '/api/v2/notification-settings'].includes(url.pathname)) {
        ownerResponses.push({ path: url.pathname, status: response.status() });
      }
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === 'https://static.cloudflareinsights.com/beacon.min.js') {
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* synthetic analytics vendor */' });
        return;
      }
      if (url.pathname.startsWith('/api/v2/external/')) {
        externalRequests.push({ sourceType: url.searchParams.get('source_type'), directory: url.searchParams.get('lookup') === 'directory' });
      }
      if (allowed.includes(url.origin)) await route.continue();
      else { unexpected.push(url.origin); await route.abort(); }
    });
    await context.routeWebSocket('**/*', socket => {
      unexpected.push(new URL(socket.url).origin);
      socket.close({ code: 1008, reason: 'Unplanned WebSocket' });
    });

    await step('open config endpoint', () => page.goto(`${proxy.origin}/api/v2/config`, { waitUntil: 'load' }));
    await step('open login and submit synthetic owner', async () => {
      await page.goto(`${proxy.origin}/api/v2/auth/login?returnTo=%2Fadd`, { waitUntil: 'commit' });
      await page.getByLabel('邮箱', { exact: true }).fill(ownerEmail);
      await page.locator('#password').fill(ownerPassword);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL(/\/add/);
    });
    const message = '当前账号无权查询外部课表';
    await step('install forbidden school mode', async () => {
      await school({ mode: 'external_forbidden', clearEvents: true });
      externalRequests.length = 0;
    });
    await step('search room and observe forbidden failure', async () => {
      await page.getByRole('tab', { name: '教室', exact: true }).click();
      await page.getByLabel('搜索教室', { exact: true }).fill('合成教室');
      const alert = page.getByRole('alert');
      await alert.waitFor({ state: 'visible' });
      assert.ok((await alert.innerText()).includes(message));
      await page.getByRole('button', { name: '重试搜索', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.getByRole('button', { name: '订阅合成教室', exact: true }).count(), 0);
      assert.deepEqual(externalRequests.filter(request => request.sourceType === 'room').map(request => request.directory), [true, false]);
      const failed = await school({});
      assert.equal(failed.events.filter(event => event.kind === 'catalog_room').length, 1);
    });
    await step('recover with explicit retry', async () => {
      await school({ mode: 'success', clearEvents: true });
      await page.getByRole('button', { name: '重试搜索', exact: true }).click();
      await page.getByRole('button', { name: '订阅合成教室', exact: true }).waitFor({ state: 'visible' });
      assert.deepEqual(externalRequests.filter(request => request.sourceType === 'room').map(request => request.directory), [true, false, true, false]);
      const recovered = await school({});
      assert.equal(recovered.events.filter(event => event.kind === 'catalog_room').length, 1);
    });
    await step('read back empty owner subscriptions', async () => {
      const state = await (await fetch(`${runtime.controlOrigin}/state?account=owner`)).json();
      assert.deepEqual(state.subscriptions, []);
    });
    assert.deepEqual(unexpected, [], 'Unexpected browser origin was observed');

    const loginCookie = proxy.observations.find(observation => observation.path === '/api/v2/auth/login')
      ?.setCookies.find(cookie => cookie.name === '__Host-schedule_login');
    const callback = proxy.observations.find(observation => observation.path === '/callback');
    assert.ok(loginCookie?.secure && loginCookie.httpOnly, 'Product login cookie lost Secure/HttpOnly semantics');
    assert.equal(callback?.requestCookieNames.includes('__Host-schedule_login'), true,
      'WebKit did not return the Secure login cookie over local HTTPS');
    return {
      browserVersion: context.browser()?.version() ?? null,
      ignoreHTTPSErrors: true,
      failure,
      consoleEntries,
      ownerResponses,
      steps,
      unexpectedOrigins: unexpected,
      cookieEvidence: {
        loginCookie,
        callbackRequestCookiePresent: callback.requestCookieNames.includes('__Host-schedule_login'),
      },
    };
  } catch (error) {
    primaryError = error;
    failure.url = page?.url() ?? null;
    failure.alertText = await page?.getByRole('alert').innerText().catch(() => null) ?? null;
    throw error;
  } finally {
    const errors = [];
    try { await context?.close(); } catch (error) { errors.push(error); }
    const browserDisconnected = context?.browser()?.isConnected() === false;
    let profileRemoved = false;
    try {
      await rm(profile, { recursive: true, force: true });
      await stat(profile).then(() => { throw new Error('Disposable WebKit profile remains'); }, error => {
        if (error.code !== 'ENOENT') throw error;
      });
      profileRemoved = true;
    } catch (error) { errors.push(error); }
    receipt.browserCleanup = { browserDisconnected, profileRemoved, errors: errors.map(describeError) };
    if (errors.length) throw preserveFailures(primaryError, errors, 'Supplemental WebKit cleanup failed');
  }
}

let runtime;
let proxy;
let reservation;
let primaryError;
try {
  await installWebKit();
  reservation = await holdLoopbackPort();
  receipt.reservedPort = reservation.port;
  const publicOrigin = `https://127.0.0.1:${reservation.port}`;
  runtime = await startSchedule({
    authDirectory: resolve(root, '.e2e/deps/auth'),
    authCommit: dependency.commit,
    external: true,
    accountNames: ['owner'],
    publicOrigin,
  });
  receipt.authCommit = runtime.authCommit;
  receipt.directOrigin = runtime.directOrigin;
  const backendPort = Number(new URL(runtime.directOrigin).port);
  proxy = await startLocalTlsProxy({ backendPort, output, reservation });
  receipt.tlsOrigin = proxy.origin;
  receipt.certificateFingerprint = proxy.certificateFingerprint;

  if (mode === 'stock-red') {
    const stock = await runStockEngine(runtime, proxy);
    receipt.stockEngine = stock;
    assert.equal(stock.passed, true, 'Expected the stock tester-army WebKit engine to fail on the local test certificate');
  } else {
    receipt.supplemental = await runSupplementalJourney(runtime, proxy);
    receipt.proxyUpgrades = proxy.upgrades.map(upgrade => ({ ...upgrade }));
  }
  receipt.status = 'passed';
  receipt.cleanup.status = 'pending';
} catch (error) {
  primaryError = error;
  receipt.errors = [describeError(error)];
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  function inheritedCleanup(error) {
    if (error?.cleanupErrors?.length) cleanupErrors.push(...error.cleanupErrors.map(describeError));
    else if (error instanceof AggregateError && /and cleanup failed$/.test(error.message)) {
      cleanupErrors.push(...error.errors.slice(1).map(describeError));
    }
    if (error instanceof AggregateError) for (const nested of error.errors) inheritedCleanup(nested);
  }
  inheritedCleanup(primaryError);
  try { if (proxy) receipt.tlsCleanup = await proxy.close(); }
  catch (error) { cleanupErrors.push(describeError(error)); receipt.tlsCleanup = error.cleanupEvidence; }
  try { if (runtime) await verifyRuntimeCleanup(runtime); }
  catch (error) { cleanupErrors.push(describeError(error)); }
  try {
    if (reservation) { await reservation.release(); receipt.reservationReleased = true; }
  } catch (error) { cleanupErrors.push(describeError(error)); }
  receipt.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors };
  if (cleanupErrors.length) { receipt.status = 'failed'; process.exitCode = 1; }
  const resultPath = join(output, `${mode}-result.json`);
  await writeFile(resultPath, JSON.stringify(receipt, null, 2) + '\n');
  try {
    if (runtime) await runtime.checkArtifacts(output);
  } catch (error) {
    receipt.status = 'failed';
    receipt.artifactCheck = describeError(error);
    await writeFile(resultPath, JSON.stringify(receipt, null, 2) + '\n');
    process.exitCode = 1;
  }
  console.log(`${mode} ${viewportName}: ${receipt.status}; cleanup ${receipt.cleanup.status}; evidence ${output}`);
}
