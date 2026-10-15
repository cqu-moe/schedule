import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { installNetworkGuard, externalRequests, login } from './browser-fixture';

installNetworkGuard();

for (const [type, label, name] of [
  ['room', '教室', '合成教室'], ['laboratory', '实验室', '合成实验室'],
  ['instructor', '教师', '合成教师'], ['admin_class', '班级', '合成行政班'],
  ['course', '课程', '合成电路01班'],
]) test(`external ${type}: select from the real page, consume the queue and read the published calendar`,
  { tags: ['account:owner', 'external'] }, async ({ app, browser, screen }) => {
  await login({ app, browser, screen });
  await screen.getByRole('tab', type === 'admin_class' ? '行政班' : label, { exact: true }).click();
  await screen.getByLabel(`搜索${label}`, { exact: true }).fill(type === 'course' ? '合成电路' : name);
  if (type === 'course') {
    await screen.getByRole('button', '选择课程合成电路', { exact: true }).click();
    await expect(screen.getByRole('heading', '合成电路 · 选择教学班', { exact: true })).toBeVisible();
  }
  await screen.getByRole('button', `订阅${name}`, { exact: true }).click();
  await expect(screen.getByRole('button', `已订阅${name}`, { exact: true })).toBeVisible();
  const deadline = Date.now() + 90000;
  let subscription: any;
  while (Date.now() < deadline) {
    subscription = await browser.evaluate(async (type: string) => {
      const response = await fetch('/api/v2/subscriptions');
      if (!response.ok) throw new Error('Subscription readback failed');
      return (await response.json()).subscriptions.find((item: any) => item.source_type === type);
    }, type);
    if (subscription?.sync_status === 'success' || subscription?.sync_status === 'error') break;
    await new Promise(done => setTimeout(done, 2000));
  }
  expect(subscription?.sync_error_code).toBe(null);
  expect(subscription?.sync_status).toBe('success');
  expect(subscription.source_name).toBe(name);
  const token = subscription.links.find((link: any) => link.is_default).token;
  const response = await fetch(`${process.env.SCHEDULE_E2E_URL}/api/v2/calendar/${token}/calendar.ics`,
    { headers: { 'CF-Connecting-IP': '203.0.113.21' } });
  expect(response.status).toBe(200);
  const calendar = await response.text();
  expect(calendar).toContain('SUMMARY:外部电路基础');
  expect(calendar).toContain('DTSTART:20260907T003000Z');
  expect(calendar).toContain(`LOCATION:${type === 'laboratory' ? '合成实验室' : '合成教室'}`);
  expect((calendar.match(/BEGIN:VEVENT/g) || []).length).toBe(type === 'admin_class' ? 4 : 2);
  if (type === 'admin_class') expect(calendar).toContain('SUMMARY:外部高等数学');
  await app.open('/dashboard');
  await expect(screen.getByRole('link', `查看课表：${name}`, { exact: true })).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole('link', `查看课表：${name}`, { exact: true })).toBeVisible();
});


for (const [name, status, code] of [
  ['owner', 503, 'EXTERNAL_UNAVAILABLE'], ['no-external', 403, 'FEATURE_NOT_ENABLED'],
  ['unbound', 409, 'CQU_SESSION_INACTIVE'],
] as const) test(`external gate ${name}: source availability, rights and binding remain independent`,
  { tags: [`account:${name}`, 'external', ...(name === 'owner' ? ['external-disabled'] : [])] },
  async ({ app, browser, screen }) => {
    await login({ app, browser, screen }, name);
    if (name === 'owner') await expect(screen.getByText('外部订阅（教师、教室、课程、行政班等）功能暂不可用。', {exact:true})).toBeVisible();
    if (name === 'no-external') await expect(screen.getByText('外部订阅（教师、教室、课程、行政班等）功能尚未开通。', {exact:true})).toBeVisible();
    const outcomes = await browser.evaluate(async () => {
      const responses = [
        await fetch('/api/v2/external/search?source_type=room&keyword=合成教室&lookup=directory'),
        await fetch('/api/v2/subscriptions', {method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({sourceType:'room',sourceId:'41',sourceName:'合成教室',sessionId:'202610',selectionToken:'untrusted'})}),
      ];
      return Promise.all(responses.map(async response => ({status:response.status,body:await response.json()})));
    });
    for (const outcome of outcomes) {
      expect(outcome.status).toBe(status);
      expect(outcome.body.detail.error.code).toBe(code);
    }
    const state = await (await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/state?account=${name}`)).json();
    expect(state.subscriptions).toEqual([]);
  });

test('external selection belongs to its actual authorized user, not another bound user',
  {tags:['account:owner','account:other','external']}, async ({app,browser,screen}) => {
    await login({app,browser,screen});
    const selected = await browser.evaluate(async () => {
      const response = await fetch('/api/v2/external/search?source_type=room&keyword=合成教室');
      if (!response.ok) throw new Error('Owner must obtain a real school selection');
      return response.json();
    });
    expect((await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/secrets`, {method:'POST',
      body:JSON.stringify([selected.selection_token])})).status).toBe(204);
    await browser.goto(`${process.env.SCHEDULE_AUTH_URL}/settings`);
    await screen.getByRole('button','退出登录',{exact:true}).click();
    await login({app,browser,screen}, 'other');
    const result = await browser.evaluate(async (receipt: any) => {
      const me = await (await fetch('/api/v2/me')).json();
      const response = await fetch('/api/v2/subscriptions', {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({sourceType:'room',sourceId:'41',sourceName:'合成教室',sessionId:receipt.session.id,selectionToken:receipt.selection_token})});
      return {me,status:response.status,body:await response.json()};
    }, selected);
    expect(result.status).toBe(409);
    expect(result.body.detail.error.code).toBe('EXTERNAL_SELECTION_EXPIRED');
    // The same second user can obtain their own receipt and actually subscribe.
    await screen.getByRole('tab','教室',{exact:true}).click();
    await screen.getByLabel('搜索教室',{exact:true}).fill('合成教室');
    await screen.getByRole('button','订阅合成教室',{exact:true}).click();
    await expect(screen.getByRole('button','已订阅合成教室',{exact:true})).toBeVisible();
    for (const account of ['owner','other']) {
      const state = await (await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/state?account=${account}`)).json();
      expect(state.subscriptions.length).toBe(account === 'owner' ? 0 : 1);
    }
  });


for (const [mode, message] of [
  ['external_forbidden', '当前账号无权查看该目标'],
  ['external_schema_error', '外部课表暂时无法查询，请稍后重试'],
]) test(`external search ${mode}: real school failure is visible and an explicit retry can recover`,
  {tags:['account:owner','external']}, async ({app,browser,screen}) => {
    await login({app,browser,screen});
    async function school(changes: Record<string, unknown>) {
      const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/school?account=owner`,
        {method:'POST',body:JSON.stringify(changes)});
      expect(response.status).toBe(200);
      return response.json();
    }
    await school({mode,clearEvents:true});
    externalRequests.length = 0;
    await screen.getByRole('tab','教室',{exact:true}).click();
    await screen.getByLabel('搜索教室',{exact:true}).fill('合成教室');
    await expect(screen.getByText(message,{exact:true})).toBeVisible();
    await expect(screen.getByRole('button','订阅合成教室',{exact:true})).toHaveCount(0);
    expect(externalRequests.filter(x=>x.sourceType==='room').map(x=>x.directory)).toEqual([true,false]);
    const failed = await school({});
    expect(failed.events.filter((event: any)=>event.kind==='catalog_room').length).toBe(1);
    await school({mode:'success',clearEvents:true});
    await screen.getByRole('button','重试搜索',{exact:true}).click();
    await expect(screen.getByRole('button','订阅合成教室',{exact:true})).toBeVisible();
    expect(externalRequests.filter(x=>x.sourceType==='room').map(x=>x.directory)).toEqual([true,false,true,false]);
    const recovered = await school({});
    expect(recovered.events.filter((event: any)=>event.kind==='catalog_room').length).toBe(1);
    expect((await (await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/state?account=owner`)).json()).subscriptions).toEqual([]);
  });
