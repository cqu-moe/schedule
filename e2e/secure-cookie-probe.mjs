import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { firefox, webkit } from 'playwright-core';
import { preserveFailures, describeError } from './local-tls.mjs';

const cookieName = '__Host-schedule_login';
const cookieValue = 'synthetic-secure-cookie-probe';
const output = resolve(process.env.SCHEDULE_SECURE_COOKIE_OUTPUT || '.e2e/secure-cookie-probe');
assert.ok(output.startsWith(resolve('.e2e') + '/'), 'Evidence must stay under .e2e');
await mkdir(output, { recursive: true });

const sourceFiles = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).sort();
const digest = createHash('sha256');
for (const file of sourceFiles) digest.update(file + '\0').update(await readFile(file));
const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  fingerprint: digest.digest('hex'),
};

const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  requests.push({ path: url.pathname, cookieHeaderPresent: request.headers.cookie?.includes(cookieName) === true });
  if (url.pathname === '/set') {
    response.writeHead(302, {
      'cache-control': 'no-store',
      location: '/echo',
      'set-cookie': `${cookieName}=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    }).end();
    return;
  }
  if (url.pathname === '/echo') {
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' })
      .end(JSON.stringify({ cookieHeaderPresent: request.headers.cookie?.includes(cookieName) === true }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
const port = server.address().port;
const origin = `http://localhost:${port}`;

async function probe(engineName, browserType) {
  const profiles = join(output, '.profiles');
  await mkdir(profiles, { recursive: true });
  const profile = await mkdtemp(join(profiles, `${engineName}-`));
  let context;
  let primaryError;
  const result = {
    engine: engineName,
    browserVersion: null,
    profileRemoved: false,
    browserDisconnected: false,
    cookieStored: false,
    requestCookieReceived: false,
  };
  receipt.engines.push(result);
  try {
    context = await browserType.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1440, height: 900 },
    });
    result.browserVersion = context.browser()?.version() ?? null;
    const page = context.pages()[0] ?? await context.newPage();
    const echoed = page.waitForResponse(response => new URL(response.url()).pathname === '/echo');
    await page.goto(`${origin}/set`, { waitUntil: 'commit' });
    const response = await echoed;
    assert.equal(response.status(), 200);
    result.requestCookieReceived = (await response.json()).cookieHeaderPresent;
    result.cookieStored = (await context.cookies(origin)).some(cookie =>
      cookie.name === cookieName && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
    return result;
  } catch (error) {
    primaryError = error;
    result.error = describeError(error);
    throw error;
  } finally {
    const errors = [];
    try { await context?.close(); } catch (error) { errors.push(error); }
    result.browserDisconnected = context?.browser()?.isConnected() === false;
    try {
      await rm(profile, { recursive: true, force: true });
      await stat(profile).then(() => { throw new Error('Disposable profile remains'); }, error => {
        if (error.code !== 'ENOENT') throw error;
      });
      result.profileRemoved = true;
    } catch (error) { errors.push(error); }
    result.cleanupErrors = errors.map(describeError);
    if (errors.length) throw preserveFailures(primaryError, errors, `${engineName} browser cleanup failed`);
  }
}

const receipt = { schemaVersion: 'secure-cookie-probe-1', source, origin, requests: [], engines: [], status: 'failed' };
try {
  const firefoxResult = await probe('firefox', firefox);
  const webkitResult = await probe('webkit', webkit);
  receipt.requests = requests.map(request => ({ ...request }));
  receipt.conclusion = {
    firefoxAcceptedSecureCookieOnHttpLocalhost: firefoxResult.cookieStored && firefoxResult.requestCookieReceived,
    webkitRejectedSecureCookieOnHttpLocalhost: !webkitResult.cookieStored && !webkitResult.requestCookieReceived,
  };
  assert.equal(receipt.conclusion.firefoxAcceptedSecureCookieOnHttpLocalhost, true,
    'Firefox control no longer accepts the Secure __Host cookie on HTTP localhost');
  assert.equal(receipt.conclusion.webkitRejectedSecureCookieOnHttpLocalhost, true,
    'WebKit did not reproduce rejection of the Secure __Host cookie on HTTP localhost');
  receipt.status = 'passed';
} catch (error) {
  receipt.error = describeError(error);
  receipt.status = 'failed';
  process.exitCode = 1;
} finally {
  try {
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    receipt.serverClosed = true;
  } catch (error) {
    receipt.serverClosed = false;
    receipt.serverCleanupError = describeError(error);
    receipt.status = 'failed';
    process.exitCode = 1;
  }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
}

console.log(`Secure cookie probe: ${receipt.status}; evidence ${output}`);
