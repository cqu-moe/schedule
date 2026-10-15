import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { installNetworkGuard, login } from './browser-fixture';
import { age, control, createShare, cron, expire, external, payload, publicRead, request, school, subscriptions, waitForSubscription, withSchoolInput } from './lifecycle-fixture';

installNetworkGuard();
const tags = ['account:owner', 'external', 'lifecycle:external'];

async function schoolAdmin(action: 'ban' | 'entitlement', body: Record<string, unknown>) {
  const response = await fetch(`${process.env.SCHEDULE_SCHOOL_CONTROL}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', ...body }), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json() as { error?: string };
  if (response.status !== 200) throw new Error(`Real school admin ${action} failed (${response.status}): ${result.error || 'unknown'}`);
  return result;
}

test('lifecycle term: native cron expires teaching classes; only explicit UI reselection restores the same links',
  { tags, timeout: 300000 }, async fixture => {
    const { app, browser, screen } = fixture;
    await login(fixture);
    const initial = await external(fixture, 'course', '合成电路01班');
    const share = await createShare(fixture, initial.view.source_name);
    const originalLinks = (await control()).links.map(link => ({ id: link.id, token: link.token }));
    await school({ mode: 'schedule_v2', session: '202611', pageSession: '202611', clearEvents: true });
    await cron();
    const expired = await waitForSubscription(sub => sub.external_state === 'expired', 'course');
    expect(expired.sync_error_code).toBe('EXTERNAL_TERM_EXPIRED');
    expect(expired.is_active).toBe(0);
    expect(payload(expired)).toEqual(payload(initial.stored));
    for (const token of [initial.token, share.token]) expect((await publicRead(token)).status).toBe(403);
    const denied = await request(browser, `/api/v2/subscriptions/${initial.stored.id}/syncs`, 'POST');
    expect(denied.status).toBe(409);
    expect(denied.body.detail.error.code).toBe('EXTERNAL_TERM_EXPIRED');
    // Restoring entitlement must not silently match the old class by name.
    await schoolAdmin('entitlement', { enabled: false });
    await schoolAdmin('entitlement', { enabled: true });
    await expire('caps');
    await cron();
    expect((await control()).subscriptions[0].external_state).toBe('expired');
    expect((await school()).events.some(event => event.kind === 'external_table_course')).toBe(false);
    // Interactive search caches have a real 60-second TTL; allow old-term
    // receipts to expire before selecting the new school term.
    await new Promise(resolve => setTimeout(resolve, 61000));
    await app.open('/dashboard');
    await browser.reload();
    await expect(screen.getByText('教学班已过期，请重新选择教学班。全部公共链接暂时停用。', { exact: true })).toBeVisible();
    await screen.getByRole('link', `重新选择教学班：${initial.view.source_name}`, { exact: true }).click();
    await expect(browser).toHaveURL(new RegExp(`/add\\?reselect=${initial.stored.id}`));
    await screen.getByLabel('搜索课程', { exact: true }).fill('合成电路');
    await screen.getByRole('button', '选择课程合成电路', { exact: true }).click();
    await expect(screen.getByRole('button', '重选合成电路02班新学期', { exact: true })).toBeVisible();
    await withSchoolInput({ mode: 'schedule_v2_hold', hold: true, clearEvents: true }, { mode: 'schedule_v2', hold: false }, async () => {
      await screen.getByRole('button', '重选合成电路02班新学期', { exact: true }).click();
      await waitForSubscription(sub => sub.external_state === 'reselecting' && sub.sync_status === 'running', 'course');
      for (const token of [initial.token, share.token]) expect((await publicRead(token)).status).toBe(403);
    });
    const restored = await waitForSubscription(sub => sub.external_state === 'active' && sub.sync_status === 'success' && sub.session_id === '202611', 'course');
    expect(restored.id).toBe(initial.stored.id);
    expect(restored.source_id).toBe('63');
    expect(restored.source_name).toBe('合成电路02班新学期');
    expect(restored.target_revision > initial.stored.target_revision).toBe(true);
    const snapshot = await control();
    expect(snapshot.subscriptions.length).toBe(1);
    expect(snapshot.links.map(link => ({ id: link.id, token: link.token }))).toEqual(originalLinks);
    expect(snapshot.externalUsage).toEqual([]);
    for (const token of [initial.token, share.token]) {
      const calendar = await publicRead(token);
      expect(calendar.status).toBe(200);
      expect(calendar.text).toContain('SUMMARY:外部电路新版');
      expect(calendar.text).toContain('DTSTART:20270222T003000Z');
    }
    await app.open('/dashboard');
    await browser.reload();
    await expect(screen.getByRole('link', '查看课表：合成电路02班新学期', { exact: true })).toBeVisible();
    await expect(screen.getByRole('link', `重新选择教学班：${initial.view.source_name}`, { exact: true })).toHaveCount(0);
    expect((await subscriptions(browser)).length).toBe(1);
  });

test('lifecycle rights: real administrator revocation denies manual work and cron disables links; regrant restores eligible links',
  { tags, timeout: 240000 }, async fixture => {
    const { app, browser, screen } = fixture;
    await login(fixture);
    const initial = await external(fixture);
    const share = await createShare(fixture, initial.view.source_name);
    await schoolAdmin('entitlement', { enabled: false });
    const me = await request(browser, '/api/v2/me');
    expect(me.status).toBe(200);
    expect(me.body.caps.calendar.external).toBe(false);
    const denied = await request(browser, `/api/v2/subscriptions/${initial.stored.id}/syncs`, 'POST');
    expect(denied.status).toBe(403);
    expect(denied.body.detail.error.code).toBe('FEATURE_NOT_ENABLED');
    await expire('caps');
    await cron();
    const revoked = await control();
    expect(revoked.subscriptions[0].is_active).toBe(0);
    expect(payload(revoked.subscriptions[0])).toEqual(payload(initial.stored));
    expect(revoked.subscriptions[0].sync_run_id).toBe(initial.stored.sync_run_id);
    for (const token of [initial.token, share.token]) expect((await publicRead(token)).status).toBe(403);
    await app.open('/dashboard');
    await browser.reload();
    await expect(screen.getByRole('listitem').filter({ hasText: initial.view.source_name }).getByRole('button', '外部订阅未开通', { exact: true })).toBeDisabled();
    await schoolAdmin('entitlement', { enabled: true });
    await expire('caps');
    await cron();
    expect((await control()).subscriptions[0].is_active).toBe(1);
    for (const token of [initial.token, share.token]) expect((await publicRead(token)).status).toBe(200);
    await browser.reload();
    await expect(screen.getByRole('link', `查看课表：${initial.view.source_name}`, { exact: true })).toBeVisible();
  });

for (const cause of ['ban', 'unbind'] as const) test(`lifecycle ${cause}: actual central changes deny protected work and cannot publish a new background success`,
  { tags, timeout: 240000 }, async fixture => {
    const { app, browser } = fixture;
    await login(fixture);
    const initial = await external(fixture);
    await age(initial.stored.id, 'last_synced_at', 61);
    const before = (await control()).subscriptions[0];
    if (cause === 'ban') await schoolAdmin('ban', { banned: true });
    else {
      await browser.goto(`${process.env.SCHEDULE_AUTH_URL}/settings`);
      const status = await browser.evaluate(async () => (await fetch('/api/v1/cqu/binding', { method: 'DELETE' })).status);
      expect(status).toBe(204);
    }
    await app.open('/api/v2/config');
    const denied = await request(browser, `/api/v2/subscriptions/${initial.stored.id}/syncs`, 'POST');
    expect(denied.status).toBe(cause === 'ban' ? 401 : 409);
    expect(denied.body.detail.error.code).toBe(cause === 'ban' ? 'UNAUTHORIZED' : 'CQU_SESSION_INACTIVE');
    await expire('caps');
    // No fixture browser input after central unbind/ban: only the real cron.
    await cron(false);
    const retained = cause === 'ban' ? (await control()).subscriptions[0]
      : await waitForSubscription(sub => sub.sync_status === 'error' && sub.sync_run_id !== initial.stored.sync_run_id, 'room');
    if (cause === 'ban') expect(retained.sync_run_id).toBe(initial.stored.sync_run_id);
    else expect(retained.sync_error_code).toBe('NEEDS_REAUTH');
    expect(retained.last_synced_at).toBe(before.last_synced_at);
    expect(payload(retained)).toEqual(payload(initial.stored));
    expect((await control()).externalUsage).toEqual([]);
  });
