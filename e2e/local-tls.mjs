import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';

const run = (command, args, options = {}) => new Promise((done, fail) => {
  execFile(command, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      fail(error);
      return;
    }
    done({ stdout, stderr });
  });
});

export function preserveFailures(primaryError, cleanupErrors, message) {
  if (!cleanupErrors.length) return primaryError;
  return Object.assign(new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, message),
    { primaryError, cleanupErrors });
}

export function describeError(error) {
  return {
    name: error?.name ?? 'Error', message: error?.message ?? String(error),
    ...(error instanceof AggregateError ? { errors: error.errors.map(describeError) } : {}),
    ...(error?.primaryError ? { primaryError: describeError(error.primaryError) } : {}),
    ...(error?.cleanupErrors ? { cleanupErrors: error.cleanupErrors.map(describeError) } : {}),
    ...(error?.cleanupEvidence ? { cleanupEvidence: error.cleanupEvidence } : {}),
  };
}

export function verifyStockTlsFailure({ report, runnerExitCode, signal, timedOut, expectedId, title, targetId, origin }) {
  assert.equal(timedOut, false, 'Stock TLS control timed out');
  assert.equal(signal, null, 'Stock TLS control was interrupted');
  assert.equal(runnerExitCode, 3, 'Stock TLS control must exit with an engine error');
  const run = report?.run;
  assert.equal(run?.status, 'error');
  assert.equal(run.exitCode, runnerExitCode);
  assert.deepEqual(run.errors, [], 'Stock TLS control has unrelated run errors');
  for (const [key, value] of Object.entries({ selected: 1, executed: 1, failed: 1, passed: 0, interrupted: 0, flaky: 0, skipped: 0 })) {
    assert.equal(run.summary[key], value, `Stock TLS summary ${key}`);
  }
  const selected = run.results.filter(test => test.selected);
  assert.equal(selected.length, 1);
  const test = selected[0];
  assert.equal(test.id, expectedId);
  assert.equal(test.kind, 'test');
  assert.deepEqual(test.titlePath, [title]);
  assert.equal(test.targetId, targetId);
  assert.equal(test.status, 'failed');
  assert.equal(run.targets.find(target => target.id === targetId)?.baseOrigin, origin);
  assert.equal(test.attempts.length, 1, 'Stock TLS control must have exactly one attempt');
  const attempt = test.attempts[0];
  assert.equal(attempt.index, 0);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.cleanup, 'complete');
  assert.deepEqual(attempt.secondaryErrors, [], 'Stock TLS control has secondary failures');
  assert.equal(attempt.error?.code, 'ENGINE_FAILURE');
  assert.equal(attempt.error?.phase, 'beforeEach');
  assert.match(attempt.error.message, /^navigation failed: page\.goto: The certificate for this server is invalid\./);
  assert.ok(attempt.error.message.includes(`navigating to "${origin}/api/v2/config"`));
  const failedSteps = attempt.steps.filter(step => step.status === 'failed');
  assert.equal(failedSteps.length, 1);
  const step = failedSteps[0];
  assert.equal(step.phase, 'beforeEach');
  assert.equal(step.api, 'app.open');
  assert.equal(step.label, '/api/v2/config');
  assert.equal(step.error?.code, 'ENGINE_FAILURE');
  assert.equal(step.error?.message, attempt.error.message);
  assert.ok(attempt.steps.every(step => step.phase === 'beforeEach'), 'Stock TLS control reached a later phase');
  return { passed: true, runnerExitCode, testId: test.id, attemptId: attempt.id,
    error: attempt.error, cleanup: attempt.cleanup, summary: run.summary };
}

export async function holdLoopbackPort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return {
    port: server.address().port,
    async release() {
      if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}

async function assertClosed(port) {
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); fail(new Error(`Local TLS listener ${port} remains open`)); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error(`Local TLS listener ${port} cleanup readback timed out`)); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : fail(error));
  });
}

function cookieNames(value) {
  return value.split(';').map(part => part.trim().split('=')[0]).filter(Boolean);
}

function setCookieFacts(values) {
  return values.map(value => {
    const [nameValue, ...attributes] = value.split(';');
    const name = nameValue.split('=')[0].trim();
    return {
      name,
      secure: attributes.some(attribute => attribute.trim().toLowerCase() === 'secure'),
      httpOnly: attributes.some(attribute => attribute.trim().toLowerCase() === 'httponly'),
      sameSite: attributes.find(attribute => attribute.trim().toLowerCase().startsWith('samesite='))?.split('=')[1],
    };
  });
}

export async function startLocalTlsProxy({ backendPort, output, reservation }) {
  assert.ok(Number.isInteger(backendPort) && backendPort > 0, 'A backend port is required');
  assert.ok(reservation && Number.isInteger(reservation.port) && reservation.port > 0, 'A held TLS port is required');
  const port = reservation.port;
  assert.ok(output, 'An evidence output is required');
  let certificateDirectory;
  let server;
  const observations = [];
  const upgrades = [];
  async function close() {
    const errors = [];
    const evidence = { listenerClosed: false, reservationReleased: false, certificateMaterialRemoved: false };
    try {
      if (server?.listening) {
        server.closeAllConnections?.();
        await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      }
    } catch (error) { errors.push(error); }
    try { await reservation.release(); evidence.reservationReleased = true; } catch (error) { errors.push(error); }
    try { await assertClosed(port); evidence.listenerClosed = true; } catch (error) { errors.push(error); }
    try {
      if (certificateDirectory) {
        await rm(certificateDirectory, { recursive: true, force: true });
        await stat(certificateDirectory).then(() => { throw new Error('TLS certificate material remains'); }, error => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      evidence.certificateMaterialRemoved = true;
    } catch (error) { errors.push(error); }
    if (errors.length) throw Object.assign(preserveFailures(null, errors, 'Local TLS proxy cleanup failed'), { cleanupEvidence: evidence });
    return evidence;
  }

  function proxy(request, response) {
    const url = new URL(request.url, `https://127.0.0.1:${port}`);
    const headers = { ...request.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers['transfer-encoding'];
    delete headers.upgrade;
    const upstream = httpRequest({
      host: '127.0.0.1', port: backendPort, method: request.method, path: request.url, headers,
    }, upstreamResponse => {
      const facts = {
        method: request.method,
        path: url.pathname,
        status: upstreamResponse.statusCode,
        requestCookieNames: cookieNames(request.headers.cookie ?? ''),
        setCookies: setCookieFacts(upstreamResponse.headers['set-cookie'] ?? []),
      };
      observations.push(facts);
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      delete responseHeaders['keep-alive'];
      delete responseHeaders['proxy-connection'];
      delete responseHeaders['transfer-encoding'];
      response.writeHead(upstreamResponse.statusCode, responseHeaders);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`Local TLS proxy upstream failed: ${error.message}`);
    });
    request.pipe(upstream);
  }

  try {
    certificateDirectory = await mkdtemp(join(output, '.tls-certificate-'));
    const keyPath = join(certificateDirectory, 'key.pem');
    const certificatePath = join(certificateDirectory, 'cert.pem');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
    const [key, certificate] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
    const certificateFingerprint = createHash('sha256').update(certificate).digest('hex');
    server = createTlsServer({ key, cert: certificate }, proxy);
    server.on('upgrade', (request, socket) => {
      upgrades.push({ path: new URL(request.url, `https://127.0.0.1:${port}`).pathname });
      socket.destroy();
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    await reservation.release();
    await new Promise((done, reject) => server.once('error', reject).listen(port, '127.0.0.1', done));
    return { origin: `https://127.0.0.1:${port}`, certificateFingerprint, observations, upgrades, close };
  } catch (primaryError) {
    const cleanupErrors = [];
    let cleanupEvidence;
    try { cleanupEvidence = await close(); }
    catch (error) { cleanupErrors.push(error); cleanupEvidence = error.cleanupEvidence; }
    throw Object.assign(preserveFailures(primaryError, cleanupErrors, 'TLS startup and cleanup failed'), { cleanupEvidence });
  }
}
