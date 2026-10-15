import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { installNetworkGuard, login } from './browser-fixture';
import { control, createShare, external, openLinks, payload, personal, publicRead, request, subscriptions } from './lifecycle-fixture';

installNetworkGuard();

test('lifecycle links: edit formats, reopen, rotate and delete through the owner UI; reject another owner',
  { tags: ['account:owner', 'account:other', 'lifecycle:personal'], timeout: 240000 }, async fixture => {
    const { app, browser, screen } = fixture;
    await login(fixture);
    const initial = await personal(fixture);
    const shared = await createShare(fixture, initial.view.source_name, '合成旧标签');
    expect((await publicRead(shared.token)).status).toBe(200);
    expect((await publicRead(shared.token, 'data.json')).status).toBe(403);
    await screen.getByRole('row').filter({ hasText: '合成旧标签' }).getByRole('button', '修改', { exact: true }).click();
    await screen.getByLabel('标签（可选，最多 100 字符）', { exact: true }).fill('合成新标签');
    const form = screen.getByRole('dialog').filter({ hasText: '修改链接标签或允许的格式。' });
    await form.getByRole('button', '日历订阅 (ICS)', { exact: true }).click();
    await form.getByRole('button', 'CSV', { exact: true }).click();
    await form.getByRole('button', '保存', { exact: true }).click();
    await expect(screen.getByRole('row').filter({ hasText: '合成新标签' })).toBeVisible();
    await browser.reload();
    await openLinks(fixture, initial.view.source_name);
    await expect(screen.getByRole('row').filter({ hasText: '合成新标签' })).toBeVisible();
    let snapshot = await control();
    const edited = snapshot.links.find(link => link.id === shared.id)!;
    expect(edited.label).toBe('合成新标签');
    expect(JSON.parse(edited.formats).sort()).toEqual(['csv', 'web']);
    expect(edited.token).toBe(shared.token);
    expect((await publicRead(shared.token)).status).toBe(403);
    const csv = await publicRead(shared.token, 'data.csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(process.env.SCHEDULE_E2E_BREAK_ASSERTION ? '故意错误的链接导出内容' : '合成电路基础');
    const web = await publicRead(shared.token, 'view.json');
    expect(web.status).toBe(200);
    expect(web.text).toContain('合成电路基础');
    await screen.getByRole('row').filter({ hasText: '合成新标签' }).getByRole('button', '轮换', { exact: true }).click();
    await screen.getByRole('dialog').filter({ hasText: '确认轮换链接 Token' }).getByRole('button', '轮换', { exact: true }).click();
    await expect(screen.getByText('已轮换', { exact: true })).toBeVisible();
    snapshot = await control();
    const rotated = snapshot.links.find(link => link.id === shared.id)!;
    expect(rotated.token).not.toBe(shared.token);
    expect((await publicRead(shared.token, 'data.csv')).status).toBe(404);
    expect((await publicRead(rotated.token, 'data.csv')).status).toBe(200);
    await browser.reload();
    await openLinks(fixture, initial.view.source_name);
    expect((await control()).links.find(link => link.id === shared.id)!.token).toBe(rotated.token);
    await screen.getByRole('row').filter({ hasText: '合成新标签' }).getByRole('button', '删除', { exact: true }).click();
    await screen.getByRole('dialog').filter({ hasText: '确认删除共享链接' }).getByRole('button', '删除', { exact: true }).click();
    await expect(screen.getByRole('row').filter({ hasText: '合成新标签' })).toHaveCount(0);
    await browser.reload();
    await openLinks(fixture, initial.view.source_name);
    await expect(screen.getByRole('row').filter({ hasText: '合成新标签' })).toHaveCount(0);
    expect((await publicRead(rotated.token, 'data.csv')).status).toBe(404);
    expect((await publicRead(initial.token)).status).toBe(200);
    const ownerState = await control();
    expect(payload(ownerState.subscriptions[0])).toEqual(payload(initial.stored));
    expect(ownerState.links.length).toBe(3);
    const defaultLink = initial.view.links.find((link: any) => link.is_default);
    expect((await request(browser, `/api/v2/subscriptions/${initial.view.id}/links/${defaultLink.id}`, 'PATCH', { formats: ['csv'] })).status).toBe(403);
    expect((await request(browser, `/api/v2/subscriptions/${initial.view.id}/links/${defaultLink.id}`, 'DELETE')).status).toBe(403);

    await browser.goto(`${process.env.SCHEDULE_AUTH_URL}/settings`);
    await screen.getByRole('button', '退出登录', { exact: true }).click();
    // Owner management/reloads used the real per-IP minute budget. Start the
    // separate ownership check after that window, without raising its limit.
    await new Promise(resolve => setTimeout(resolve, 61000));
    await login(fixture, 'other');
    const path = `/api/v2/subscriptions/${initial.view.id}/links/${defaultLink.id}`;
    for (const [method, suffix, body] of [['GET', '', undefined], ['PATCH', '', { label: '越权' }], ['DELETE', '', undefined], ['POST', '/rotations', undefined]] as const) {
      expect((await request(browser, path + suffix, method, body)).status).toBe(404);
    }
    expect(await control()).toEqual(ownerState);
    await app.open('/dashboard');
    await expect(screen.getByRole('list', '课表订阅', { exact: true })).toBeVisible();
  });

test('lifecycle quota observation 103: default personal views preserve one external slot and UI deletion revokes its links',
  { tags: ['account:owner', 'external', 'lifecycle:mixed'], timeout: 240000 }, async fixture => {
    const { app, browser, screen } = fixture;
    await login(fixture);
    await personal(fixture);
    const me = await request(browser, '/api/v2/me');
    expect(me.body.caps.calendar.sub_limit).toBe(1);
    const room = await external(fixture);
    const views = await subscriptions(browser);
    expect(views.filter(sub => sub.is_personal).length).toBe(3);
    expect(views.filter(sub => sub.source_version === 1).length).toBe(1);
    const shared = await createShare(fixture, room.view.source_name);
    const before = await control();
    const selected = await request(browser, '/api/v2/external/search?source_type=laboratory&keyword=合成实验室');
    expect(selected.status).toBe(200);
    const quota = await request(browser, '/api/v2/subscriptions', 'POST', {
      sourceType: 'laboratory', sourceId: '42', sourceName: '合成实验室',
      sessionId: selected.body.session.id, selectionToken: selected.body.selection_token,
    });
    expect(quota.status).toBe(409);
    expect(quota.body.detail.error.code).toBe('QUOTA_EXCEEDED');
    expect((await control()).subscriptions).toEqual(before.subscriptions);
    // Initial setup/share/quota and later deletion are distinct owner flows.
    // Keep the production per-IP budget and begin the latter in a fresh window.
    await new Promise(resolve => setTimeout(resolve, 61000));
    await app.open('/dashboard');
    await screen.getByRole('button', `${room.view.source_name}的更多操作`, { exact: true }).click();
    await screen.getByRole('menuitem', '删除', { exact: true }).click();
    await screen.getByRole('dialog').filter({ hasText: '确认删除订阅' }).getByRole('button', '删除', { exact: true }).click();
    await expect(screen.getByRole('link', `查看课表：${room.view.source_name}`, { exact: true })).toHaveCount(0);
    await browser.reload();
    expect((await subscriptions(browser)).filter(sub => sub.source_version === 1)).toEqual([]);
    expect((await control()).subscriptions.map(sub => sub.source_type)).toEqual(['personal']);
    expect((await publicRead(room.token)).status).toBe(404);
    expect((await publicRead(shared.token)).status).toBe(404);
    const next = await external(fixture, 'laboratory', '合成实验室');
    expect(next.stored.source_type).toBe('laboratory');
    expect((await publicRead(next.token)).status).toBe(200);
  });
