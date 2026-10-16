import assert from 'node:assert/strict';

// A private observer shares the actual KV namespace. It can expire cache inputs,
// never provide a harvest, authorization decision or successful sync result.
export const lifecycleObserver = {
  name: 'schedule-lifecycle-inputs', modules: true, compatibilityDate: '2026-05-01',
  kvNamespaces: { CACHE: 'schedule-e2e-cache' },
  script: `export default {async fetch(request, env) {
    const {userId, expire} = await request.json();
    if (!userId || !['caps', 'harvest', null].includes(expire)) return new Response(null, {status:400});
    if (expire) await env.CACHE.delete((expire === 'caps' ? 'caps:' : 'harvest:direct-v1:') + userId);
    const day = new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
    return Response.json({personalManualUsed: Number(await env.CACHE.get('refresh:'+userId+':'+day) || 0)});
  }}`,
  outboundService: () => new Response('Observer has no external network', { status: 502 }),
};

export async function lifecycleControls({ runtime, db, accounts, profile, secrets }) {
  assert.ok(['personal', 'external', 'mixed'].includes(profile));
  const inputs = [], observations = [];
  const lastObserved = new Map();
  // These grants are caller prerequisites, installed before any application login
  // or subscription. All records under test must still be created by the product.
  const grants = {
    sync: profile === 'external' ? '0' : '1', external: profile === 'personal' ? '0' : '1',
    share: '1', share_limit: '2', sub_limit: '1',
    sync_interval: profile === 'external' ? '120' : '60',
    manual_refresh: profile === 'external' ? '1' : '2',
    external_manual_refresh: profile === 'personal' ? '1' : '2',
    external_sync_interval: profile === 'personal' ? '120' : '60',
  };
  for (const account of Object.values(accounts)) {
    for (const [capability, value] of Object.entries(grants)) {
      // Auth's flag write contract represents revocation by absence, never 0.
      if (value === '0' && ['sync', 'external'].includes(capability)) {
        await runtime.db.prepare("DELETE FROM user_entitlement WHERE user_id=? AND subsystem='calendar' AND capability=?")
          .bind(account.userId, capability).run();
        continue;
      }
      await runtime.db.prepare(`INSERT INTO user_entitlement(user_id,subsystem,capability,value)
        VALUES (?,'calendar',?,?) ON CONFLICT(user_id,subsystem,capability) DO UPDATE SET value=excluded.value`)
        .bind(account.userId, capability, value).run();
    }
  }
  inputs.push({ action: 'initial-grants', profile, grants });
  const observer = await runtime.getWorker('schedule-lifecycle-inputs');
  async function cache(account, expire = null) {
    const result = await observer.fetch('http://inputs/', {
      method: 'POST', body: JSON.stringify({ userId: account.userId, expire }),
    });
    assert.equal(result.status, 200);
    return result.json();
  }
  async function state(account) {
    const subscriptions = (await db.prepare(`SELECT id,source_type,source_version,source_id,source_name,
      session_id,external_state,target_revision,is_active,sync_status,sync_run_id,sync_trigger,
      sync_error_code,last_synced_at,manual_refresh_at,sync_requested_at,sync_started_at,
      courses_json,exams_json,ics_content,import_quality
      FROM subscriptions WHERE user_id=? ORDER BY id`).bind(account.userId).all()).results;
    const links = (await db.prepare(`SELECT l.id,l.subscription_id,l.token,l.label,l.formats,l.is_active,l.is_default
      FROM calendar_links l JOIN subscriptions s ON s.id=l.subscription_id
      WHERE s.user_id=? ORDER BY l.id`).bind(account.userId).all()).results;
    for (const link of links) secrets.add(link.token);
    const usage = (await db.prepare('SELECT quota_date,used_count FROM external_manual_refresh_usage WHERE user_id=? ORDER BY quota_date')
      .bind(account.userId).all()).results;
    const term = await db.prepare('SELECT session_id,status,next_check_at,checked_at FROM external_term_checks WHERE user_id=?')
      .bind(account.userId).first();
    const snapshot = { subscriptions, links, externalUsage: usage, term, ...await cache(account) };
    const signature = JSON.stringify(snapshot);
    if (lastObserved.get(account.userId) !== signature) {
      lastObserved.set(account.userId, signature);
      observations.push({ at: new Date().toISOString(), userId: account.userId, ...snapshot });
      assert.ok(observations.length <= 128, 'Unexpected unbounded lifecycle transitions');
    }
    return snapshot;
  }
  return {
    async diagnostics() {
      const snapshots = {};
      for (const [name, account] of Object.entries(accounts)) snapshots[name] = await state(account);
      return { inputs, observations, snapshots };
    },
    async handle(request, response, url, account) {
      if (url.pathname !== '/lifecycle') return false;
      assert.ok(account, 'A configured synthetic account is required');
      if (request.method === 'POST') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        assert.ok(raw.length < 4096);
        const { action, id, field, minutes } = JSON.parse(raw);
        if (action === 'age-clock') {
          assert.ok(['last_synced_at', 'manual_refresh_at', 'sync_requested_at'].includes(field));
          assert.ok(Number.isFinite(minutes) && minutes >= 0 && minutes <= 7 * 24 * 60);
          const row = await db.prepare(`SELECT ${field} AS value FROM subscriptions WHERE id=? AND user_id=?`)
            .bind(id, account.userId).first();
          assert.ok(row && row.value && Number.isFinite(Date.parse(row.value)), 'Only an actual existing clock may be aged');
          const value = new Date(Date.now() - minutes * 60_000).toISOString();
          const result = await db.prepare(`UPDATE subscriptions SET ${field}=? WHERE id=? AND user_id=? AND ${field}=?`)
            .bind(value, id, account.userId, row.value).run();
          assert.equal(result.meta.changes, 1);
          inputs.push({ action, id, field, before: row.value, after: value });
        } else if (action === 'expire-cache') {
          assert.ok(['caps', 'harvest'].includes(field));
          await cache(account, field);
          inputs.push({ action, field });
        } else if (action === 'cron') {
          const before = await state(account);
          const worker = await runtime.getWorker('schedule-e2e');
          const result = await worker.scheduled({ cron: '*/15 * * * *' });
          inputs.push({ action, outcome: result.outcome, beforeRunIds: before.subscriptions.map(s => s.sync_run_id) });
          assert.equal(result.outcome, 'ok');
        } else throw new Error('Unknown lifecycle input');
      } else assert.equal(request.method, 'GET');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(await state(account)));
      return true;
    },
  };
}
