import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export const password = 'Synthetic-only-123!';
const clientId = 'schedule-e2e-browser';
const clientSecret = 'synthetic-schedule-oauth-secret';

async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function assertClosed(port) {
  await new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Local test listener ${port} remains open`)); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Listener cleanup verification timed out')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : reject(error));
  });
}

async function registerClient(db, origin) {
  // Only caller prerequisites are seeded. Users, school binding, sessions,
  // subscription state and OAuth grants must come from the production APIs.
  const values = {
    id: clientId, clientId, clientSecret: createHash('sha256').update(clientSecret).digest('base64url'),
    disabled: 0, skipConsent: 1, enableEndSession: 1,
    scopes: JSON.stringify(['openid', 'profile', 'email', 'offline_access']),
    redirectUris: JSON.stringify([`${origin}/callback`]),
    postLogoutRedirectUris: JSON.stringify([`${origin}/signed-out`]),
    tokenEndpointAuthMethod: 'client_secret_basic',
    grantTypes: JSON.stringify(['authorization_code', 'refresh_token']),
    responseTypes: JSON.stringify(['code']), public: 0, type: 'web', requirePKCE: 1,
    name: 'Schedule E2E', uri: origin, applicationType: 'web',
    metadata: JSON.stringify({ subsystem: 'calendar', rpcMethods: ['getCaps', 'cquHarvest', 'cquExternalSearch', 'cquExternalCapture', 'cquExternalDirectory'] }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const columns = Object.keys(values);
  await db.prepare(`INSERT INTO oauthClient(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .bind(...Object.values(values)).run();
  const row = await db.prepare(`SELECT ${columns.join(',')} FROM oauthClient WHERE clientId=?`).bind(clientId).first();
  assert.deepEqual(row, values, 'OAuth caller prerequisites must read back exactly');
}

export async function startSchedule({ authDirectory, authCommit, accountNames = ['owner', 'other', 'unbound', 'no-sync'], external = false, directory = false, sourceTypes = 'admin_class,instructor,room,laboratory,course' }) {
  assert.match(authCommit, /^[a-f0-9]{40}$/, 'A fixed Auth commit is required');
  const root = process.cwd();
  const auth = resolve(authDirectory);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: auth, encoding: 'utf8' }).trim(), authCommit);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: auth, encoding: 'utf8' }).trim(), '');
  await mkdir(join(root, '.e2e'), { recursive: true });
  const work = await mkdtemp(join(root, '.e2e', 'runtime-'));
  const unexpected = [];
  const authRequests = [];
  const secrets = new Set([password, clientSecret]);
  let runtime, control, assetRuntime;
  try {
    const fixture = join(work, 'school');
    await mkdir(fixture);
    const base = await readFile(join(auth, 'e2e/school/school.py'), 'utf8');
    const entry = '\nasyncio.run(main())\n';
    assert.ok(base.endsWith(entry), 'Pinned Auth school fixture entrypoint changed');
    await writeFile(join(fixture, 'school.py'), base.slice(0, -entry.length) + '\nEXTERNAL_PAGE = ' + JSON.stringify(await readFile(join(root, 'e2e/school-external.html'), 'utf8')) + '\n' +
      await readFile(join(root, 'e2e/school-extension.py'), 'utf8'));
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run',
      '--config', 'e2e/wrangler.jsonc', '--outdir', work], {
      cwd: root, stdio: 'pipe', env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(work, 'build.log') },
    });
    const scriptPath = join(work, 'index.js');
    const contents = await readFile(scriptPath, 'utf8');
    // Miniflare 4.20260521.0 uses one fixed Assets:storage service name per
    // instance. Give this second production build its own native asset store;
    // the business Worker, Auth RPC, D1 and Queue still share the main runtime.
    const { Miniflare } = createRequire(join(auth, 'package.json'))('miniflare');
    assetRuntime = new Miniflare({
      host: '127.0.0.1', port: 0, name: 'schedule-assets', modules: true,
      compatibilityDate: '2026-05-01',
      script: 'export default {fetch(request, env) {return env.ASSETS.fetch(request)}}',
      assets: { workerName: 'schedule-assets', directory: join(root, 'frontend/dist'), binding: 'ASSETS',
        routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true },
        assetConfig: { not_found_handling: 'single-page-application' } },
      outboundService: () => new Response('Asset service has no external network', { status: 502 }),
    });
    const assetOrigin = await assetRuntime.ready;
    const assets = await assetRuntime.getWorker();
    const expectedHtml = await readFile(join(root, 'frontend/dist/index.html'), 'utf8');
    assert.equal(await (await assets.fetch('http://assets.test/')).text(), expectedHtml,
      'The actual Schedule production assets must be served, not another worker build');
    const port = await reservePort();
    const origin = `http://localhost:${port}`;
    const migrations = await readD1Migrations(join(root, 'drizzle/migrations'));
    const { startSchoolAuth } = await import(pathToFileURL(join(auth, 'e2e/school/runtime.mjs')).href);
    process.chdir(auth);
    runtime = await startSchoolAuth({ expectedCommit: authCommit, fixtureDirectory: fixture,
      workers: ({ authOrigin, authWorkerName }) => [{
        name: 'schedule-e2e', modulesRoot: work, modules: [{ type: 'ESModule', path: scriptPath, contents }],
        compatibilityDate: '2026-05-01', compatibilityFlags: ['nodejs_compat'],
        unsafeDirectSockets: [{ host: '127.0.0.1', port, entrypoint: 'default' }],
        d1Databases: { DB: 'schedule-e2e' }, kvNamespaces: { CACHE: 'schedule-e2e-cache' },
        serviceBindings: {
          AUTH: { name: authWorkerName, entrypoint: 'AuthService' },
          ASSETS: request => assets.fetch(request.url, { method: request.method, headers: [...request.headers] }),
        },
        bindings: { PUBLIC_URL: origin, AUTH_ORIGIN: authOrigin, CALENDAR_CLIENT_ID: clientId,
          CALENDAR_CLIENT_SECRET: clientSecret, PERSONAL_SUBSCRIPTION_MODE: 'enabled',
          ...(external ? { EXTERNAL_SUBSCRIPTION_TYPES: sourceTypes } : {}),
          ENVIRONMENT: 'development', POSTHOG_ENABLED: '0', GIT_COMMIT: 'e2e', GIT_DATE: '2026-10-15' },
        ratelimits: { UNAUTH_LIMITER: { simple: { limit: 5, period: 60 } },
          AUTH_LIMITER: { simple: { limit: 40, period: 60 } }, EXTERNAL_LIMITER: { simple: { limit: 10, period: 60 } } },
        queueProducers: { SCHEDULE_SYNC_QUEUE: 'schedule-sync', SCHEDULE_NOTIFICATION_QUEUE: 'schedule-notifications' },
        queueConsumers: { 'schedule-sync': { maxBatchSize: 5, maxBatchTimeout: 1, maxRetries: 45 } },
        outboundService: async request => {
          const url = new URL(request.url);
          if (url.origin !== authOrigin) {
            unexpected.push(url.origin);
            return new Response('Unexpected Schedule egress denied', { status: 502 });
          }
          const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
          if (body) for (const [key, value] of new URLSearchParams(body)) {
            if (['code', 'refresh_token', 'token', 'code_verifier'].includes(key)) secrets.add(value);
          }
          const response = await fetch(url, { method: request.method, headers: [...request.headers],
            ...(body === undefined ? {} : { body }),
            redirect: 'manual', signal: AbortSignal.timeout(15000) });
          const observation = { method: request.method, path: url.pathname, status: response.status };
          if (url.pathname.endsWith('/token') && response.ok) {
            const tokens = await response.clone().json();
            for (const key of ['access_token', 'refresh_token', 'id_token']) if (tokens[key]) secrets.add(tokens[key]);
          }
          if (url.pathname.endsWith('/introspect')) {
            const detail = await response.clone().json();
            observation.authority = { active: detail.active, clientMatches: detail.client_id === clientId,
              hasSid: typeof detail.sid === 'string' && !!detail.sid,
              hasSub: typeof detail.sub === 'string' && !!detail.sub,
              hasExpiry: typeof detail.exp === 'number', caps: detail.caps, binding: detail.cquBindStatus };
          }
          if (!response.ok) {
            const detail = await response.clone().json().catch(() => null);
            if (typeof detail?.error === 'string') observation.error = detail.error;
            if (typeof detail?.error_description === 'string') observation.description = detail.error_description;
          }
          authRequests.push(observation);
          return response;
        },
      }],
    });
    let db = await runtime.getD1Database('DB', 'schedule-e2e');
    for (const migration of migrations) for (const query of migration.queries) await db.prepare(query).run();
    await registerClient(runtime.db, origin);
    const { prepareSchoolBinding } = await import(pathToFileURL(join(auth, 'e2e/school/prepare-binding.mjs')).href);
    const accounts = {};
    assert.ok(accountNames.length && accountNames.every(key => ['owner', 'other', 'unbound', 'no-sync', 'no-external'].includes(key)));
    for (const key of accountNames) {
      const email = `${key}@example.test`;
      accounts[key] = key === 'owner' || (external && ['other', 'no-external'].includes(key))
        ? await prepareSchoolBinding(runtime, { email, password })
        : await runtime.prepare({ email, password });
      await runtime.db.prepare(`INSERT INTO user_entitlement(user_id,subsystem,capability,value)
        VALUES (?,'calendar','sync',?) ON CONFLICT(user_id,subsystem,capability) DO UPDATE SET value=excluded.value`)
        .bind(accounts[key].userId, key === 'no-sync' || external ? '0' : '1').run();
    }
    if (accounts['no-external']) await runtime.db.prepare("UPDATE user_entitlement SET value='0' WHERE user_id=? AND subsystem='calendar' AND capability='external'").bind(accounts['no-external'].userId).run();
    if (external) for (const account of Object.values(accounts)) {
      for (const [capability, value] of Object.entries({sub_limit: '10', external_manual_refresh: '10', external_sync_interval: '60'})) {
        await runtime.db.prepare("INSERT INTO user_entitlement(user_id,subsystem,capability,value) VALUES (?,'calendar',?,?) ON CONFLICT(user_id,subsystem,capability) DO UPDATE SET value=excluded.value")
          .bind(account.userId, capability, value).run();
      }
    }
    if (directory) {
      assert.ok(accounts.owner, 'Directory source requires a real bound owner');
      await runtime.updateConsumerBindings('schedule-e2e', { EXTERNAL_DIRECTORY_USER_ID: accounts.owner.userId });
      db = await runtime.getD1Database('DB', 'schedule-e2e');
    }
    const directoryInputs = [];
    async function directoryState() {
      return {
        state: await db.prepare('SELECT * FROM external_directory_state WHERE id=1').first(),
        runs: (await db.prepare('SELECT id,status,phase,session_id,next_attempt_at,lease_until,last_error,failure_count FROM external_directory_runs ORDER BY started_at,id').all()).results,
        items: (await db.prepare('SELECT run_id,kind,id,name FROM external_directory_items ORDER BY run_id,kind,id').all()).results,
        courseCache: (await db.prepare('SELECT user_id,session_id,course_id FROM external_directory_course_cache ORDER BY user_id,session_id,course_id').all()).results,
      };
    }
    control = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const account = accounts[url.searchParams.get('account')];
        if (directory && url.pathname === '/directory-contention' && request.method === 'GET') {
          const since = Number(url.searchParams.get('since'));
          assert.ok(Number.isFinite(since) && since > 0);
          const diagnostics = await runtime.diagnostics();
          const outcomes = diagnostics.runtimeLog.flatMap(line => {
            try {
              const event = JSON.parse(line);
              return event.evt === 'st_mint' && event.clientId === clientId &&
                event.userId === accounts.owner.userId && event.source === 'rpc' && event.ts >= since
                ? [{ at: event.ts, outcome: event.outcome }] : [];
            } catch { return []; }
          });
          directoryInputs.push({ action: 'observe-contention', since, outcomes });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(outcomes)); return;
        }
        if (directory && url.pathname === '/directory' && ['GET', 'POST'].includes(request.method)) {
          if (request.method === 'POST') {
            let raw = ''; for await (const chunk of request) raw += chunk;
            const { action } = JSON.parse(raw);
            const before = await directoryState();
            const active = before.runs.find(run => run.id === before.state.active_run_id);
            const worker = await runtime.getWorker('schedule-e2e');
            directoryInputs.push({ action, phaseBefore: active?.phase ?? null });
            // Only clocks and interrupted/legacy inputs are injected. The real
            // cron, Queue, Auth RPC and container must produce every catalog row,
            // phase transition and publication pointer.
            if (action === 'start-week') {
              assert.equal(before.state.active_run_id, null);
              await db.prepare('UPDATE external_directory_state SET next_due_at=0 WHERE id=1').run();
              assert.equal((await worker.scheduled({ cron: '*/15 * * * *' })).outcome, 'ok');
            } else if (action === 'expire-foreground') {
              await db.prepare('UPDATE external_directory_state SET foreground_until=0 WHERE id=1').run();
            } else if (action === 'duplicate') {
              assert.ok(active);
              const body = { purpose:'external_directory',subscriptionId:'directory',userId:accounts.owner.userId,runId:active.id,trigger:'cron' };
              const result = await worker.queue('schedule-sync', [1, 2].map(index => ({id:`duplicate-${index}`,timestamp:new Date(),attempts:2,body})));
              assert.equal(result.outcome, 'ok');
              assert.equal(result.retryMessages.length, 0);
            } else {
              assert.ok(active && active.status === 'running', 'Clock/fault input requires a real in-progress generation');
              if (action === 'hold-lease') {
                await db.prepare("UPDATE external_directory_runs SET lease_token='interrupted-e2e-lease',lease_until=? WHERE id=?")
                  .bind(Date.now()+120_000,active.id).run();
              } else {
                assert.ok(['deliver-due','expired-lease','legacy-teacher','expired-run'].includes(action));
                if (action === 'expired-lease') await db.prepare('UPDATE external_directory_runs SET lease_until=? WHERE id=?').bind(Date.now()-1,active.id).run();
                if (action === 'legacy-teacher') await db.prepare('UPDATE external_directory_runs SET phase=5 WHERE id=?').bind(active.id).run();
                if (action === 'expired-run') await db.prepare('UPDATE external_directory_runs SET started_at=? WHERE id=?').bind(Date.now()-6*24*60*60_000,active.id).run();
                await db.prepare('UPDATE external_directory_runs SET next_attempt_at=0,dispatch_until=0 WHERE id=?').bind(active.id).run();
                assert.equal((await worker.scheduled({cron:'*/15 * * * *'})).outcome, 'ok');
              }
            }
          }
          response.setHeader('content-type','application/json');
          response.end(JSON.stringify(await directoryState())); return;
        }
        if (request.method === 'POST' && url.pathname === '/secrets') {
          let raw = ''; for await (const chunk of request) raw += chunk;
          const values = JSON.parse(raw);
          assert.ok(Array.isArray(values) && values.every(value => typeof value === 'string' && value.length < 4096));
          for (const value of values) if (value) secrets.add(value);
          response.writeHead(204).end(); return;
        }
        if (url.pathname === '/school' && account && ['GET', 'POST'].includes(request.method)) {
          let raw = ''; for await (const chunk of request) raw += chunk;
          const upstream = await fetch(runtime.schoolOrigin + '/fixture?email=' + encodeURIComponent(account.email),
            request.method === 'POST' ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:account.email,changes:JSON.parse(raw)})} : {});
          assert.equal(upstream.status, 200);
          response.setHeader('content-type', 'application/json'); response.end(await upstream.text()); return;
        }
        if (request.method !== 'GET' || url.pathname !== '/state' || !account) {
          response.writeHead(404).end(); return;
        }
        const rows = await db.prepare(`SELECT id,source_type,sync_status,sync_error_code,last_synced_at
          FROM subscriptions WHERE user_id=? ORDER BY id`).bind(account.userId).all();
        const views = await db.prepare(`SELECT v.source_type FROM personal_subscription_views v
          JOIN subscriptions s ON s.id=v.subscription_id WHERE s.user_id=? ORDER BY v.source_type`)
          .bind(account.userId).all();
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ subscriptions: rows.results, views: views.results }));
      } catch { response.writeHead(500).end('Readback failed'); }
    });
    await new Promise((done, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', done); });
    const controlPort = control.address().port;
    return { origin, authOrigin: runtime.origin, authCommit, db, accounts,
      controlOrigin: `http://127.0.0.1:${control.address().port}`, schoolOrigin: runtime.schoolOrigin,
      async diagnostics() {
        const rows = await db.prepare('SELECT source_type,source_name,sync_status,sync_error_code,sync_error_message,import_quality,skipped_count FROM subscriptions ORDER BY source_type').all();
        const school = accounts.owner ? await (await fetch(runtime.schoolOrigin + '/fixture?email=owner%40example.test')).json() : null;
        return { subscriptions: rows.results, school, ...(directory ? { directory: await directoryState(), directoryInputs } : {}) };
      },
      async close() {
        const errors = [];
        let resources;
        try {
          const links = await db.prepare('SELECT token FROM calendar_links').all();
          for (const row of links.results) secrets.add(row.token);
        } catch (error) { errors.push(error); }
        try { await new Promise((done, reject) => control.close(error => error ? reject(error) : done())); }
        catch (error) { errors.push(error); }
        try { resources = await runtime.close(); } catch (error) { errors.push(error); }
        try { await assetRuntime.dispose(); } catch (error) { errors.push(error); }
        for (const stopped of [port, controlPort, Number(assetOrigin.port)]) {
          try { await assertClosed(stopped); } catch (error) { errors.push(error); }
        }
        process.chdir(root);
        try { await rm(work, { recursive: true, force: true }); } catch (error) { errors.push(error); }
        if (unexpected.length) errors.push(new Error(`Unexpected Schedule egress: ${[...new Set(unexpected)].join(', ')}`));
        if (errors.length) throw new AggregateError(errors, 'Schedule cleanup or egress check failed');
        return { ...resources, scheduleStorageRemoved: true, assetServiceStopped: true,
          listenersClosed: [port, controlPort, Number(assetOrigin.port)], authRequests };
      },
      async checkArtifacts(path) {
        await runtime.redact(path);
        async function visit(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (/\.(json|md|log|txt)$/.test(entry.name)) {
              let contents = await readFile(file, 'utf8');
              for (const secret of secrets) if (secret) contents = contents.split(secret).join('[synthetic-secret-redacted]');
              contents = contents.replace(/([?&](?:code|state|nonce|sig|code_challenge)=)[^&\s"<>\\]+/g, '$1[synthetic-secret-redacted]');
              await writeFile(file, contents);
            }
          }
        }
        await visit(path);
        // Redaction changes text attachment bytes. Keep the framework's
        // attachment receipts consistent with the actual sanitized files.
        const reportPath = join(path, 'report.json');
        let report;
        try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (report) {
          const artifactRoot = resolve(path, 'results');
          async function update(value) {
            if (!value || typeof value !== 'object') return;
            if (typeof value.path === 'string' && typeof value.sha256 === 'string' && typeof value.size === 'number') {
              const artifact = resolve(artifactRoot, value.path);
              assert.ok(artifact.startsWith(artifactRoot + '/'), 'Artifact must remain inside this run');
              const bytes = await readFile(artifact);
              value.size = bytes.length;
              value.sha256 = createHash('sha256').update(bytes).digest('hex');
            }
            for (const child of Object.values(value)) await update(child);
          }
          await update(report);
          await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
        }
        await runtime.checkArtifacts(path);
      },
    };
  } catch (error) {
    const errors = [error];
    if (control?.listening) try { await new Promise((done, reject) => control.close(error => error ? reject(error) : done())); }
    catch (cleanup) { errors.push(cleanup); }
    if (runtime) try { await runtime.close(); } catch (cleanup) { errors.push(cleanup); }
    if (assetRuntime) try { await assetRuntime.dispose(); } catch (cleanup) { errors.push(cleanup); }
    process.chdir(root);
    try { await rm(work, { recursive: true, force: true }); } catch (cleanup) { errors.push(cleanup); }
    throw errors.length > 1 ? new AggregateError(errors, 'Schedule startup and cleanup failed') : error;
  }
}
