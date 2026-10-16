import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startSchedule } from './runtime.mjs';
import { holdLoopbackPort, startLocalTlsProxy, preserveFailures } from './local-tls.mjs';

export async function startScheduleForBrowser(options) {
  if (process.env.SCHEDULE_E2E_BROWSER !== 'webkit') return startSchedule(options);
  assert.equal(options.publicOrigin, undefined, 'The release runner owns its TLS origin');
  let reservation, runtime, proxy, privateRoot;
  try {
    privateRoot = await mkdtemp(fileURLToPath(new URL('../.e2e/private-tls-', import.meta.url)));
    reservation = await holdLoopbackPort();
    runtime = await startSchedule({ ...options, publicOrigin: `https://127.0.0.1:${reservation.port}` });
    proxy = await startLocalTlsProxy({ backendPort: Number(new URL(runtime.directOrigin).port),
      output: privateRoot, reservation });
  } catch (primary) {
    const cleanup = [];
    try { await proxy?.close(); } catch (error) { cleanup.push(error); }
    try { await runtime?.close(); } catch (error) { cleanup.push(error); }
    try { await reservation?.release(); } catch (error) { cleanup.push(error); }
    try { if (privateRoot) await rmdir(privateRoot); } catch (error) { cleanup.push(error); }
    throw preserveFailures(primary, cleanup, 'Release TLS startup and cleanup failed');
  }
  return {
    ...runtime,
    origin: proxy.origin,
    browserEnvironment: {
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./tls-context-loader.mjs', import.meta.url))}`,
      NODE_EXTRA_CA_CERTS: proxy.certificatePath,
    },
    async diagnostics() {
      return { ...await runtime.diagnostics(), tls: { origin: proxy.origin,
        certificateFingerprint: proxy.certificateFingerprint, observations: proxy.observations, upgrades: proxy.upgrades } };
    },
    async close() {
      const errors = [];
      let tls, resources;
      try { tls = await proxy.close(); } catch (error) { errors.push(error); }
      try { resources = await runtime.close(); } catch (error) { errors.push(error); }
      try { await reservation.release(); } catch (error) { errors.push(error); }
      try { await rmdir(privateRoot); } catch (error) { errors.push(error); }
      if (errors.length) throw preserveFailures(null, errors, 'Release TLS and runtime cleanup failed');
      return { ...resources, tls: { ...tls, privateMaterialRootRemoved: true },
        listenersClosed: [...resources.listenersClosed, reservation.port] };
    },
  };
}
