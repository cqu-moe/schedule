import { expect } from 'e2e';
import type { Browser } from '@e2e-dev/web';
import type { login } from './browser-fixture';

export type Journey = Parameters<typeof login>[0];
export interface StoredSubscription {
  id: string; source_type: string; source_name: string; source_id: string;
  source_version: number; is_active: number; external_state: string; target_revision: number;
  session_id: string | null; sync_status: string; sync_run_id: string | null;
  sync_trigger: string | null; sync_error_code: string | null;
  last_synced_at: string | null; manual_refresh_at: string | null;
  courses_json: string | null; exams_json: string | null; ics_content: string | null; import_quality: string | null;
}
export interface StoredLink { id: string; subscription_id: string; token: string; label: string | null; formats: string; is_active: number; is_default: number }
export interface Snapshot {
  subscriptions: StoredSubscription[]; links: StoredLink[];
  personalManualUsed: number; externalUsage: Array<{ quota_date: string; used_count: number }>;
  term: { session_id: string; status: string; next_check_at: number } | null;
}
export async function control(input?: Record<string, unknown>, account = 'owner'): Promise<Snapshot> {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/lifecycle?account=${account}`, input
    ? { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(30000) }
    : { signal: AbortSignal.timeout(15000) });
  expect(response.status).toBe(200);
  return response.json() as Promise<Snapshot>;
}
export async function age(id: string, field: string, minutes: number) {
  await schoolIdle();
  return control({ action: 'age-clock', id, field, minutes });
}
export const expire = (field: 'caps' | 'harvest') => control({ action: 'expire-cache', field });
export async function cron(settleSchool = true) {
  if (settleSchool) await schoolIdle();
  return control({ action: 'cron' });
}
async function schoolIdle() {
  const deadline = Date.now() + 120000;
  for (;;) {
    const activity = await school();
    if (activity.profiles === 0 && activity.chromeProcesses === 0) return;
    if (Date.now() >= deadline) throw new Error('Real school browser did not settle before the next clock input');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function school(changes?: Record<string, unknown>): Promise<{ events: Array<{ kind: string; at: number }>; state: { mode: string }; profiles: number; chromeProcesses: number }> {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/school?account=owner`, changes
    ? { method: 'POST', body: JSON.stringify(changes), signal: AbortSignal.timeout(30000) } : {});
  expect(response.status).toBe(200);
  return response.json();
}
export async function withSchoolInput<T>(changes: Record<string, unknown>, restore: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  await school(changes);
  let primary: unknown;
  try { return await body(); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await school(restore); }
    catch (cleanup) {
      if (primary) throw new AggregateError([primary, cleanup], 'School input assertion and release both failed');
      throw cleanup;
    }
  }
}
export async function waitForSubscription(predicate: (sub: StoredSubscription) => boolean, type = 'personal', timeout = 120000, requiredSchoolEvent?: string) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // Read the school input first, then its persisted application outcome. A
    // queued capacity deferral can precede the actual school request; it must
    // not complete a test whose owner is a particular school failure.
    const inputObserved = !requiredSchoolEvent || (await school()).events.some(event => event.kind === requiredSchoolEvent);
    const snapshot = await control();
    const sub = snapshot.subscriptions.find(item => item.source_type === type);
    if (inputObserved && sub && predicate(sub)) return sub;
    if (Date.now() >= deadline) throw new Error(`Subscription ${type} did not reach its required state (last=${sub?.sync_status}/${sub?.sync_error_code}; schoolInputObserved=${inputObserved})`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
export async function request(browser: Browser, path: string, method = 'GET', body?: any) {
  const result = await browser.evaluate(async ({ path, method, body }: any) => {
    const response = await fetch(path, { method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: response.status, body: await response.json() as any };
  }, { path, method, ...(body === undefined ? {} : { body }) });
  if (typeof result.body?.selection_token === 'string') await protect([result.body.selection_token]);
  return result;
}
export async function protect(values: string[]) {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/secrets`, { method: 'POST', body: JSON.stringify(values) });
  expect(response.status).toBe(204);
}
export async function subscriptions(browser: Browser): Promise<any[]> {
  const result = await request(browser, '/api/v2/subscriptions');
  expect(result.status).toBe(200);
  await control(); // Register every actually stored token before rotation/deletion.
  return result.body.subscriptions;
}
let reader = 0;
export async function publicRead(token: string, format = 'calendar.ics') {
  // Each observation is a separate synthetic anonymous reader. Keep the real
  // per-reader production limit; repeated owner UI operations are tested separately.
  const response = await fetch(`${process.env.SCHEDULE_E2E_URL}/api/v2/calendar/${token}/${format}`, {
    headers: { 'CF-Connecting-IP': `203.0.113.${100 + (++reader % 100)}` }, signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, text: await response.text() };
}
export const payload = (sub: StoredSubscription) => ({ courses: sub.courses_json, exams: sub.exams_json, ics: sub.ics_content });
export async function personal(fixture: Journey) {
  await fixture.app.open('/dashboard');
  const stored = await waitForSubscription(sub => sub.sync_status === 'success');
  const views = await subscriptions(fixture.browser);
  const all = views.find(sub => sub.source_type === 'personal_all');
  expect(Boolean(all)).toBe(true);
  return { stored, view: all, token: all.links.find((link: any) => link.is_default).token as string };
}
export async function external(fixture: Journey, type = 'room', name = '合成教室') {
  await fixture.app.open('/add');
  const label = type === 'course' ? '课程' : type === 'laboratory' ? '实验室' : '教室';
  await fixture.screen.getByRole('tab', label, { exact: true }).click();
  await fixture.screen.getByLabel(`搜索${label}`, { exact: true }).fill(type === 'course' ? '合成电路' : name);
  if (type === 'course') await fixture.screen.getByRole('button', '选择课程合成电路', { exact: true }).click();
  await fixture.screen.getByRole('button', `订阅${name}`, { exact: true }).click();
  const stored = await waitForSubscription(sub => sub.sync_status === 'success', type);
  const view = (await subscriptions(fixture.browser)).find(sub => sub.id === stored.id);
  expect(Boolean(view)).toBe(true);
  return { stored, view, token: view.links.find((link: any) => link.is_default).token as string };
}
export async function openLinks(fixture: Journey, name: string) {
  await fixture.screen.getByRole('button', `${name}的更多操作`, { exact: true }).click();
  await fixture.screen.getByRole('menuitem', '管理共享链接', { exact: true }).click();
  await expect(fixture.screen.getByRole('heading', '管理共享链接', { exact: true })).toBeVisible();
}
export async function createShare(fixture: Journey, name: string, label = '合成分享') {
  await fixture.app.open('/dashboard');
  await openLinks(fixture, name);
  await fixture.screen.getByRole('button', '新建共享链接', { exact: true }).click();
  await fixture.screen.getByLabel('标签（可选，最多 100 字符）', { exact: true }).fill(label);
  await fixture.screen.getByRole('button', '创建', { exact: true }).click();
  await expect(fixture.screen.getByRole('row').filter({ hasText: label })).toBeVisible();
  const snapshot = await control();
  const link = snapshot.links.find(item => item.label === label);
  expect(Boolean(link)).toBe(true);
  return link!;
}
