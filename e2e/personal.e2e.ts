import { test } from '@e2e-dev/web';
import { credentials, expect } from 'e2e';
import { browserContext } from '../e2e.config';
import { installNetworkGuard } from './browser-fixture';

installNetworkGuard();

async function state(account: string) {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/state?account=${account}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ subscriptions: Array<{ id: string; source_type: string; sync_status: string; sync_error_code: string | null; last_synced_at: string | null }>; views: Array<{ source_type: string }> }>;
}

test('login, create personal views, consume the real queue, read calendar contents and refuse another owner',
  { tags: ['account:owner', 'account:other'] }, async ({ app, browser, screen }) => {
  const account = credentials.user('owner');
  await app.open('/');
  await screen.getByRole('link', '开始使用', { exact: true }).click();
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill('deliberately-wrong-password');
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser.locator('#login-error')).toBeVisible();
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '重试登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/dashboard/);
  await expect(screen.getByRole('list', '课表订阅')).toBeVisible();
  const deadline = Date.now() + 120000;
  let snapshot = await state('owner');
  while ((!snapshot.subscriptions.length || snapshot.subscriptions[0].sync_status !== 'success') && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 500));
    snapshot = await state('owner');
  }
  expect(snapshot.subscriptions.length).toBe(1);
  expect(snapshot.subscriptions[0].source_type).toBe('personal');
  expect(snapshot.subscriptions[0].sync_status).toBe('success');
  expect(snapshot.subscriptions[0].last_synced_at).not.toBe(null);
  expect(snapshot.views).toEqual(['personal_all', 'personal_courses', 'personal_exams'].map(source_type => ({ source_type })));
  await browser.reload();
  const subscriptions = await browser.evaluate(async () => (await (await fetch('/api/v2/subscriptions')).json()).subscriptions);
  expect(subscriptions.length).toBe(3);
  expect(subscriptions.map((sub: any) => sub.source_type).sort()).toEqual(['personal_all', 'personal_courses', 'personal_exams']);
  const all = subscriptions.find((sub: any) => sub.source_type === 'personal_all');
  const courses = subscriptions.find((sub: any) => sub.source_type === 'personal_courses');
  const exams = subscriptions.find((sub: any) => sub.source_type === 'personal_exams');
  const token = (sub: any) => sub.links.find((link: any) => link.is_default).token;
  const calendars = await browser.evaluate(async (tokens: string[]) => {
    const results = [];
    for (const token of tokens) {
      const response = await fetch(`/api/v2/calendar/${token}/calendar.ics`);
      results.push({ status: response.status, text: await response.text() });
    }
    return results;
  }, [token(all), token(courses), token(exams)]);
  for (const result of calendars) expect(result.status).toBe(200);
  expect(calendars.map(result => (result.text.match(/BEGIN:VEVENT/g) || []).length)).toEqual([3, 2, 1]);
  expect(calendars[0].text).toContain('SUMMARY:合成电路基础');
  expect(calendars[0].text).toContain('DTSTART:20260907T003000Z');
  expect(calendars[0].text).toContain('DTSTART:20260914T003000Z');
  expect(calendars[0].text).toContain('DTSTART:20261221T010000Z');
  expect(calendars[1].text).not.toContain('SUMMARY:合成电路考试');
  expect(calendars[2].text).toContain('SUMMARY:合成电路考试');
  expect(calendars[2].text).not.toContain('SUMMARY:合成电路基础');
  if (process.env.SCHEDULE_E2E_BREAK_ASSERTION === '1') expect(calendars[0].text).toContain('故意错误的课程内容');
  const again = await browser.evaluate(async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch('/api/v2/subscriptions/defaults', { method: 'POST' });
      statuses.push(response.status);
    }
    return statuses;
  });
  expect(again).toEqual([200, 200]);
  expect((await state('owner')).subscriptions).toEqual(snapshot.subscriptions);
  // web@0.15 deliberately keeps the original tab active. Use its public
  // Playwright surface only for this real target=_blank calendar window.
  const opened = browserContext().waitForEvent('page');
  await screen.getByRole('link', `查看课表：${all.source_name}`, { exact: true }).click();
  const calendar = await opened;
  try {
    expect(new URL(calendar.url()).pathname).toContain('/view');
    async function showSeptember() {
      await calendar.getByTitle('切换到月视图', { exact: true }).click();
      const title = calendar.locator('.fc-toolbar-title');
      const month = (await title.innerText()).match(/(\d{4})年\s*(\d+)月/);
      expect(month === null).toBe(false);
      const distance = (Number(month![1]) - 2026) * 12 + Number(month![2]) - 9;
      expect(Math.abs(distance) < 120).toBe(true);
      for (let n = 0; n < Math.abs(distance); n++) {
        await calendar.getByTitle(distance > 0 ? '上一页' : '下一页', { exact: true }).click();
      }
      await calendar.getByRole('button', { name: /合成电路基础/ }).first().waitFor({ state: 'visible' });
    }
    await showSeptember();
    await calendar.getByRole('button', { name: /合成电路基础/ }).first().click();
    // The school's trailing '-1' is a staff identifier, not the display name.
    await calendar.getByRole('dialog').getByText('合成教师', { exact: true }).waitFor({ state: 'visible' });
    await calendar.getByRole('dialog').getByText(/D1144/).waitFor({ state: 'visible' });
    await calendar.reload();
    await showSeptember();
    await calendar.screenshot({ path: `${process.env.SCHEDULE_E2E_OUTPUT}/calendar-readback.png` });
  } catch (error) {
    await calendar.screenshot({ path: `${process.env.SCHEDULE_E2E_OUTPUT}/calendar-failure.png` }).catch(() => {});
    throw error;
  } finally { await calendar.close(); }
  // A separate reader has only the public link, never a session cookie.
  const publicRead = await fetch(`${process.env.SCHEDULE_E2E_URL}/api/v2/calendar/${token(all)}/calendar.ics`,
    { headers: { 'CF-Connecting-IP': '203.0.113.20' } });
  expect(publicRead.status).toBe(200);
  expect(await publicRead.text()).toBe(calendars[0].text);
  const privateRead = await fetch(`${process.env.SCHEDULE_E2E_URL}/api/v2/subscriptions/${all.id}`);
  expect(privateRead.status).toBe(401);
  // End the actual central session before logging in as a second owner.
  await browser.goto(`${process.env.SCHEDULE_AUTH_URL}/settings`);
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await app.open('/api/v2/auth/login?returnTo=%2Fdashboard');
  await screen.getByLabel('邮箱', { exact: true }).fill(credentials.user('other').username);
  await browser.locator('#password').fill(credentials.user('other').password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/dashboard/);
  const denied = await browser.evaluate(async (id: string) => {
    const read = await fetch(`/api/v2/subscriptions/${id}`);
    const write = await fetch(`/api/v2/subscriptions/${id}/syncs`, { method: 'POST' });
    return [read.status, write.status];
  }, all.id);
  expect(denied).toEqual([404, 404]);
  expect((await state('owner')).subscriptions).toEqual(snapshot.subscriptions);
});

for (const accountName of ['unbound', 'no-sync']) {
  test(`${accountName}: missing binding or entitlement cannot become successful personal data`,
    { tags: [`account:${accountName}`] }, async ({ app, browser, screen }) => {
    const account = credentials.user(accountName);
    await app.open('/api/v2/auth/login?returnTo=%2Fdashboard');
    await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
    await browser.locator('#password').fill(account.password);
    await screen.getByRole('button', '登录', { exact: true }).click();
    await expect(browser).toHaveURL(/\/dashboard/);
    if (accountName === 'unbound') {
      await expect(screen.getByText('尚未绑定重庆大学统一认证账号', { exact: true })).toBeVisible();
      const current = await state(accountName);
      expect(current.subscriptions.length).toBe(1);
      expect(current.subscriptions[0].sync_error_code).toBe('CQU_BINDING_REQUIRED');
      expect(current.subscriptions[0].last_synced_at).toBe(null);
    } else {
      await expect(screen.getByText('自动同步未开通', { exact: true })).toBeVisible();
      const defaults = await browser.evaluate(async () => (await (await fetch('/api/v2/subscriptions/defaults', { method: 'POST' })).json()));
      expect(defaults.status).toBe('skipped');
      expect((await state(accountName)).subscriptions).toEqual([]);
    }
    await browser.reload();
    expect((await state(accountName)).subscriptions.some(sub => sub.sync_status === 'success')).toBe(false);
  });
}
