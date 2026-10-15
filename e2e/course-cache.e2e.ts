import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { installNetworkGuard, login } from './browser-fixture';

installNetworkGuard();

async function school(account: string, changes: Record<string, unknown> = {}) {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/school?account=${account}`, {method:'POST',body:JSON.stringify(changes)});
  expect(response.status).toBe(200);
  return response.json();
}
async function request(browser: Browser, path: string) {
  const result = await browser.evaluate(async (path: string) => {
    const response = await fetch(path);
    return {status:response.status,body:await response.json()};
  }, path);
  if (result.body.selection_token) {
    expect((await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/secrets`, {method:'POST',body:JSON.stringify([result.body.selection_token])})).status).toBe(204);
  }
  return result;
}
const classes = (token: string, course: string, cached = true) => '/api/v2/external/teaching-classes?'+new URLSearchParams({selection_token:token,course_id:course,...(cached?{lookup:'directory'}:{})});
const names = (result: any) => result.body.results.map((item: any) => item.name);

test('on-demand teaching-class caches stay isolated by actual user and selected course',
  {tags:['account:owner','account:other','external','directory']}, async ({app,browser,screen}) => {
    await school('owner',{mode:'course_cache',clearEvents:true});
    await school('other',{mode:'course_cache_other',clearEvents:true});
    await login({app,browser,screen});
    const catalog = await request(browser,'/api/v2/external/search?source_type=course&keyword=合成');
    expect(catalog.status).toBe(200);
    expect(names(catalog)).toEqual(['合成电路','合成力学']);
    const ownerToken = catalog.body.selection_token;
    for (const [course, name] of [['31','合成电路01班'],['32','合成力学01班']]) {
      const miss = await request(browser,classes(ownerToken,course));
      expect(miss.status).toBe(409);
      expect(miss.body.detail.error.code).toBe('EXTERNAL_DIRECTORY_MISS');
      const fresh = await request(browser,classes(ownerToken,course,false));
      expect(fresh.status).toBe(200);
      expect(names(fresh)).toEqual([name]);
      await school('owner',{clearEvents:true});
      const hit = await request(browser,classes(ownerToken,course));
      expect(hit.status).toBe(200);
      expect(names(hit)).toEqual([name]);
      expect((await school('owner')).events).toEqual([]);
    }
    await browser.goto(`${process.env.SCHEDULE_AUTH_URL}/settings`);
    await screen.getByRole('button','退出登录',{exact:true}).click();
    await login({app,browser,screen},'other');
    const other = await request(browser,'/api/v2/external/search?source_type=course&keyword=合成');
    expect(other.status).toBe(200);
    const otherMiss = await request(browser,classes(other.body.selection_token,'31'));
    expect(otherMiss.status).toBe(409);
    expect(otherMiss.body.detail.error.code).toBe('EXTERNAL_DIRECTORY_MISS');
    const otherFresh = await request(browser,classes(other.body.selection_token,'31',false));
    expect(otherFresh.status).toBe(200);
    expect(names(otherFresh)).toEqual(['合成电路01班另一用户']);
    const state = await (await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/directory`)).json();
    expect(state.courseCache.length).toBe(3);
    expect([...new Set(state.courseCache.map((row: any)=>row.user_id))].length).toBe(2);
    expect(state.courseCache.filter((row: any)=>row.course_id==='32').length).toBe(1);
  });

// A separate real runtime keeps each scenario below the production 10/minute
// per-IP search quota; neither the rate limiter nor its clock is changed.
test('fresh school term observations fence old teaching-class cache entries and selection receipts',
  {tags:['account:owner','external','directory']}, async ({app,browser,screen}) => {
    await school('owner',{mode:'course_cache',clearEvents:true});
    await login({app,browser,screen});
    const catalog = await request(browser,'/api/v2/external/search?source_type=course&keyword=合成');
    expect(catalog.status).toBe(200);
    const ownerToken = catalog.body.selection_token;
    const previous = await request(browser,classes(ownerToken,'31',false));
    expect(previous.status).toBe(200);
    expect(names(previous)).toEqual(['合成电路01班']);
    await school('owner',{session:'202611',pageSession:'202611',clearEvents:true});
    // A new query obtains a real fresh school term observation, avoiding the
    // short search cache. No cache/result row or application clock is seeded.
    const next = await request(browser,'/api/v2/external/search?source_type=course&keyword=合成电');
    expect(next.status).toBe(200);
    expect(next.body.session.id).toBe('202611');
    const termMiss = await request(browser,classes(next.body.selection_token,'31'));
    expect(termMiss.status).toBe(409);
    expect(termMiss.body.detail.error.code).toBe('EXTERNAL_DIRECTORY_MISS');
    const nextFresh = await request(browser,classes(next.body.selection_token,'31',false));
    expect(nextFresh.status).toBe(200);
    expect(names(nextFresh)).toEqual(['合成电路01班新学期']);
    const stale = await request(browser,classes(ownerToken,'31',false));
    expect(stale.status).toBe(409);
    expect(stale.body.detail.error.code).toBe('EXTERNAL_SELECTION_EXPIRED');
    const state = await (await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/directory`)).json();
    expect(state.courseCache.length).toBe(2);
    expect([...new Set(state.courseCache.map((row: any)=>row.user_id))].length).toBe(1);
    expect(state.courseCache.filter((row: any)=>row.session_id==='202611').map((row: any)=>row.course_id)).toEqual(['31']);
    await app.open('/dashboard');
    await browser.reload();
    expect((await (await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/state?account=owner`)).json()).subscriptions).toEqual([]);
  });
