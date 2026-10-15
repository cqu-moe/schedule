import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { installNetworkGuard, login } from './browser-fixture';

installNetworkGuard();

interface DirectoryRun { id: string; status: string; phase: number; last_error: string | null; failure_count: number; lease_until: number; next_attempt_at: number }
interface DirectoryState {
  state: { active_run_id: string | null; catalog_run_id: string | null; foreground_until: number };
  runs: DirectoryRun[];
  items: Array<{run_id: string; kind: string; id: string; name: string}>;
}
async function directory(action?: string): Promise<DirectoryState> {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/directory`, action ? {method:'POST',body:JSON.stringify({action})} : {});
  expect(response.status).toBe(200);
  return response.json();
}
async function school(changes: Record<string, unknown> = {}, account = 'owner') {
  const response = await fetch(`${process.env.SCHEDULE_E2E_CONTROL}/school?account=${account}`, {method:'POST',body:JSON.stringify(changes)});
  expect(response.status).toBe(200);
  return response.json();
}
async function waitForRun(id: string, predicate: (run: DirectoryRun) => boolean) {
  const deadline = Date.now()+60_000;
  let state: DirectoryState;
  do {
    state = await directory();
    const run = state.runs.find(run => run.id === id);
    if (run && predicate(run)) return {state,run};
    await new Promise(resolve => setTimeout(resolve,250));
  } while (Date.now()<deadline);
  throw new Error('Real directory Queue did not reach its expected persisted outcome: '+JSON.stringify(state!.runs));
}
async function advance(id: string, phase: number) {
  const previous=(await directory()).runs.find(run=>run.id===id)!;
  await directory('deliver-due');
  const outcome = await waitForRun(id,run=>run.phase===phase || run.status!=='running' || run.failure_count>previous.failure_count);
  expect(outcome.run.phase).toBe(phase);
  expect(outcome.run.failure_count).toBe(0);
  return outcome.state;
}
async function startWeek() {
  const state = await directory('start-week');
  expect(state.state.active_run_id).not.toBe(null);
  const id = state.state.active_run_id!;
  expect(state.runs.find(run=>run.id===id)?.phase).toBe(0);
  return id;
}
async function room(browser: Browser) {
  return browser.evaluate(async () => {
    const response=await fetch('/api/v2/external/search?source_type=room&keyword=合成教室&lookup=directory');
    const body=await response.json();
    return {status:response.status, names:body.results?.map((row:{name:string})=>row.name) ?? null};
  });
}

test('weekly external directory publishes five actual school catalogs atomically and preserves the previous generation through failures',
  {tags:['account:owner','external','directory']}, async ({app,browser,screen}) => {
    await login({app,browser,screen});
    const first=await startWeek();
    for(let phase=1;phase<=5;phase++) {
      const state=await advance(first,phase);
      expect(state.state.catalog_run_id).toBe(phase===5?first:null);
    }
    const published=await directory();
    expect(published.runs.find(run=>run.id===first)?.status).toBe('complete');
    expect(published.items.map(item=>item.kind).sort()).toEqual(['admin_class','course_catalog','laboratory','room']);
    const actualSchool=await school({mode:'external_v2',clearEvents:true});
    expect(actualSchool.events).toEqual([]);
    await screen.getByRole('tab','教室',{exact:true}).click();
    await screen.getByLabel('搜索教室',{exact:true}).fill('合成教室');
    await expect(screen.getByRole('button','订阅合成教室',{exact:true})).toBeVisible();
    expect((await school()).events).toEqual([]); // Published hit cannot contact school.
    const second=await startWeek();
    await advance(second,1);
    await advance(second,2);
    const partial=await directory();
    expect(partial.items.find(item=>item.run_id===second&&item.kind==='room')?.name).toBe('合成教室新版');
    expect(partial.state.catalog_run_id).toBe(first);
    expect(await room(browser)).toEqual({status:200,names:['合成教室']});
    await school({mode:'external_empty',clearEvents:true});
    await directory('deliver-due');
    const empty=await waitForRun(second,run=>run.failure_count>0);
    expect(empty.run.phase).toBe(2);
    expect(empty.run.status).toBe('running');
    expect(empty.state.state.catalog_run_id).toBe(first);
    expect(await room(browser)).toEqual({status:200,names:['合成教室']});
    await school({mode:'external_schema_error',clearEvents:true});
    await directory('deliver-due');
    const malformed=await waitForRun(second,run=>run.failure_count>empty.run.failure_count);
    expect(malformed.run.phase).toBe(2);
    expect(malformed.state.state.catalog_run_id).toBe(first);
    await school({mode:'external_v2',clearEvents:true});
    for(let phase=3;phase<=5;phase++) await advance(second,phase);
    const replaced=await directory();
    expect(replaced.state.catalog_run_id).toBe(second);
    expect(replaced.state.active_run_id).toBe(null);
    expect(replaced.runs.find(run=>run.id===second)?.status).toBe('complete');
    expect(await room(browser)).toEqual({status:200,names:['合成教室新版']});
    await browser.reload();
    await screen.getByRole('tab','教室',{exact:true}).click();
    await screen.getByLabel('搜索教室',{exact:true}).fill('合成教室');
    await expect(screen.getByRole('button','订阅合成教室新版',{exact:true})).toBeVisible();
  });

test('directory retries respect duplicates, foreground work, interrupted leases and changed school terms',
  {tags:['account:owner','external','directory']}, async ({app,browser,screen}) => {
    await login({app,browser,screen});
    const id=await startWeek();
    await advance(id,1);
    await school({clearEvents:true});
    await directory('duplicate');
    expect((await directory()).runs.find(run=>run.id===id)?.phase).toBe(1);
    expect((await school()).events).toEqual([]);
    // A real foreground teacher search creates the persisted contention fence.
    await screen.getByRole('tab','教师',{exact:true}).click();
    await screen.getByLabel('搜索教师',{exact:true}).fill('合成教师');
    await expect(screen.getByRole('button','订阅合成教师',{exact:true})).toBeVisible();
    expect((await directory()).state.foreground_until).toBeGreaterThan(Date.now());
    await school({clearEvents:true});
    await directory('deliver-due');
    const deferred=await waitForRun(id,run=>run.next_attempt_at>Date.now()&&run.lease_until===0);
    expect(deferred.run.phase).toBe(1);
    expect(deferred.run.failure_count).toBe(0);
    expect((await school()).events).toEqual([]);
    await directory('expire-foreground');
    await directory('hold-lease');
    await directory('deliver-due');
    await directory('duplicate');
    expect((await directory()).runs.find(run=>run.id===id)?.phase).toBe(1);
    expect((await school()).events).toEqual([]);
    await directory('expired-lease');
    const recovered=await waitForRun(id,run=>run.phase>1||run.failure_count>0);
    expect(recovered.run.phase).toBe(2);
    expect(recovered.run.failure_count).toBe(0);
    await school({session:'202611',pageSession:'202611',clearEvents:true});
    await directory('deliver-due');
    const drift=await waitForRun(id,run=>run.status==='failed');
    expect(drift.run.last_error).toBe('CURRENT_SESSION_CHANGED');
    expect(drift.state.state.catalog_run_id).toBe(null);
    expect(drift.state.state.active_run_id).toBe(null);
    expect(drift.state.items.filter(item=>item.run_id===id).length).toBe(1);
  });

test('legacy teacher harvesting and expired directory runs terminate without school bulk calls',
  {tags:['account:owner','external','directory']}, async () => {
    const legacy=await startWeek();
    await school({clearEvents:true});
    await directory('legacy-teacher');
    const canceled=await waitForRun(legacy,run=>run.status==='failed');
    expect(canceled.run.last_error).toBe('TEACHER_CRAWL_CANCELLED');
    expect(canceled.state.state.catalog_run_id).toBe(null);
    expect(canceled.state.items).toEqual([]);
    expect((await school()).events).toEqual([]);
    const expired=await startWeek();
    await directory('expired-run');
    const stopped=await waitForRun(expired,run=>run.status==='failed');
    expect(stopped.run.last_error).toBe('RUN_EXPIRED');
    expect(stopped.state.state.catalog_run_id).toBe(null);
    expect(stopped.state.items).toEqual([]);
    expect((await school()).events).toEqual([]);
  });
