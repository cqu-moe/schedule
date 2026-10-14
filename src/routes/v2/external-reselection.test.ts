import { beforeAll, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { Hono } from "hono";
import { businessIdentity } from "../../test-utils/business-identity";
import type { SessionEnv } from "../../middleware/session";
import type { Env } from "../../types";
import external from "./external";
import subscriptions from "./subscriptions";
import calendar from "./calendar";
import { processScheduleSyncBatch } from "../../cron/schedule-sync";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
function harness() {
  const userId = crypto.randomUUID();
  const caps = { sync: true, external: true, share: true, sub_limit: 5, share_limit: 5, sync_interval: 60, manual_refresh: 5, change_notification: false };
  const send = vi.fn().mockResolvedValue(undefined);
  const term = { id: "current", name: "当前学期" };
  const course = { id: "catalog-physics", name: "大学物理" };
  const search = vi.fn(async (args: any) => args.sourceType === "course_catalog"
    ? { contractVersion: 1, sourceType: "course_catalog", session: term, truncated: false, items: [{ ...course, extra: "PHYS1001" }] }
    : { contractVersion: 1, sourceType: "course", course, session: term, truncated: false,
      items: [{ id: "class-01", name: "大学物理 01班", extra: "教师甲" }, { id: "class-02", name: "大学物理 02班", extra: "教师乙" }] });
  const row = { courseName: "大学物理", roomName: "D101", weekDay: 1, teachingWeek: "11", period: "11", classId: "class-02" };
  const capture = vi.fn().mockResolvedValue({ contractVersion: 1, sourceType: "course", target: { id: "class-02", name: "大学物理 02班" },
    session: { ...term, beginDate: "2026-09-07" }, timetable: { maxSection: 12, classTimetableVOList: [row, { ...row, exprProjectName: "实验项目甲", roomName: "实验楼" }, row] } });
  const testEnv = { ...env, CACHE: { get: (...args: any[]) => String(args[0]).startsWith("external-search:") ? Promise.resolve(null) : (env.CACHE.get as any)(...args), put: (...args: any[]) => (env.CACHE.put as any)(...args) }, EXTERNAL_SUBSCRIPTION_TYPES: "course", AUTH: {
    verifySession: async () => ({ user: { id: userId, name: "测试", email: "test@example.com", role: "user" }, caps: { calendar: caps }, cquBindStatus: "active" }),
    getCaps: vi.fn().mockResolvedValue({ calendar: caps }), cquExternalSearch: search, cquExternalCapture: capture,
  }, SCHEDULE_SYNC_QUEUE: { send } } as unknown as Env;
  const app = new Hono<SessionEnv>();
  app.use("/external/*", businessIdentity); app.use("/subscriptions/*", businessIdentity);
  app.route("/external", external); app.route("/subscriptions", subscriptions); app.route("/calendar", calendar);
  const request = (path: string, init?: RequestInit) => app.request(path, { ...init, headers: {
    "Content-Type": "application/json", "CF-Connecting-IP": `2001:db8:${userId.slice(0,4)}:${userId.slice(4,8)}::1`, ...init?.headers,
  } }, testEnv);
  async function catalog() {
    const response = await request("/external/search?source_type=course&keyword=物理");
    expect(response.status).toBe(200); return response.json<any>();
  }
  async function classes() {
    const found = await catalog();
    const response = await request(`/external/teaching-classes?course_id=catalog-physics&selection_token=${found.selection_token}`);
    expect(response.status).toBe(200); return response.json<any>();
  }
  async function create() {
    const found = await classes();
    const response = await request("/subscriptions", { method: "POST", body: JSON.stringify({ sourceType: "course", sourceId: "class-02", sourceName: "客户端伪造名称", sessionId: "current", selectionToken: found.selection_token }) });
    expect(response.status).toBe(201); return response.json<any>();
  }
  async function consume(index = send.mock.calls.length - 1) {
    await processScheduleSyncBatch({ queue: "schedule-sync", messages: [{ body: send.mock.calls[index][0], attempts: 1, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<any>, testEnv);
  }
  return { request, search, capture, send, catalog, classes, create, consume, userId, term, course, row, caps, testEnv };
}


async function expired(app: ReturnType<typeof harness>) {
  const created = await app.create();
  await app.consume();
  await env.DB.prepare("UPDATE subscriptions SET external_state='expired',is_active=0,target_revision=target_revision+1 WHERE id=?").bind(created.id).run();
  await env.DB.prepare("UPDATE calendar_links SET is_active=0 WHERE subscription_id=?").bind(created.id).run();
  const sharedToken = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO calendar_links(id,subscription_id,token,formats,is_default,is_active,created_at,updated_at) VALUES(?,?,?,'[\"ics\"]',0,0,?,?)")
    .bind(crypto.randomUUID(), created.id, sharedToken, new Date().toISOString(), new Date().toISOString()).run();
  app.term.id = "next"; app.term.name = "新学期";
  app.capture.mockResolvedValue({ contractVersion: 1, sourceType: "course", target: { id: "class-02", name: "大学物理 02班" },
    session: { ...app.term, beginDate: "2027-02-22" }, timetable: { maxSection: 12, classTimetableVOList: [{ ...app.row, courseName: "新学期物理" }] } });
  app.send.mockClear(); app.capture.mockClear();
  return { ...created, sharedToken };
}
async function select(app: ReturnType<typeof harness>, id: string) {
  const found = await app.classes();
  return app.request(`/subscriptions/${id}/target-selection`, { method: "POST", body: JSON.stringify({
    sourceType: "course", sourceId: "class-02", sessionId: app.term.id, selectionToken: found.selection_token,
  }) });
}
it("keeps every original URL disabled until reselected teaching-class capture succeeds without creation or manual quota", async () => {
  const app = harness(); const sub = await expired(app);
  app.caps.sub_limit = 0;
  const res = await select(app, sub.id); expect(res.status).toBe(202);
  expect((await select(app, sub.id)).status).toBe(202); expect(app.send).toHaveBeenCalledTimes(1);
  for (const token of [sub.links[0].token, sub.sharedToken]) expect((await app.request(`/calendar/${token}/calendar.ics`)).status).toBe(403);
  await app.consume();
  const current = await (await app.request(`/subscriptions/${sub.id}`)).json<any>();
  expect(current).toMatchObject({ id: sub.id, external_state: "active", session_id: "next", sync_status: "success" });
  expect(current.links.map((link: any) => link.token).sort()).toEqual([sub.links[0].token, sub.sharedToken].sort());
  for (const token of [sub.links[0].token, sub.sharedToken]) {
    const response = await app.request(`/calendar/${token}/calendar.ics`); expect(response.status).toBe(200);
    expect(await response.text()).toContain("新学期物理");
  }
  expect(await env.DB.prepare("SELECT count(*) AS count FROM subscriptions WHERE user_id=?").bind(app.userId).first()).toEqual({count:1});
});
it("restores the default link but keeps extra links revoked when share permission was removed", async () => {
  const app=harness(); const sub=await expired(app); app.caps.share=false;
  expect((await select(app,sub.id)).status).toBe(202); await app.consume();
  expect((await app.request(`/calendar/${sub.links[0].token}/calendar.ics`)).status).toBe(200);
  expect((await app.request(`/calendar/${sub.sharedToken}/calendar.ics`)).status).toBe(403);
});
it("keeps failed reselection private and enforces its own retry cooldown", async () => {
  const app=harness(); const sub=await expired(app);
  expect((await select(app,sub.id)).status).toBe(202);
  app.capture.mockResolvedValueOnce({error:"TARGET_NOT_FOUND"}); await app.consume();
  expect(await (await app.request(`/subscriptions/${sub.id}`)).json()).toMatchObject({external_state:"reselecting",sync_status:"error"});
  expect((await app.request(`/calendar/${sub.links[0].token}/calendar.ics`)).status).toBe(403);
  expect((await select(app,sub.id)).status).toBe(429);
});
it("does not re-enable a target expired again while the browser was collecting", async () => {
  const app=harness(); const sub=await expired(app);
  expect((await select(app,sub.id)).status).toBe(202);
  const captured=await app.capture(); app.capture.mockClear();
  app.capture.mockImplementationOnce(async () => {
    await env.DB.prepare("UPDATE subscriptions SET external_state='expired',target_revision=target_revision+1 WHERE id=?").bind(sub.id).run();
    return captured;
  });
  await app.consume();
  expect((await app.request(`/calendar/${sub.links[0].token}/calendar.ics`)).status).toBe(403);
  expect(await env.DB.prepare("SELECT is_active FROM calendar_links WHERE subscription_id=?").bind(sub.id).all()).toMatchObject({results:[{is_active:0},{is_active:0}]});
});
it("enforces owner, new-source lifecycle, trusted selection and current external entitlement", async () => {
  const app=harness(); const sub=await expired(app);
  const other=harness();
  expect((await select(other,sub.id)).status).toBe(404);
  expect((await app.request(`/subscriptions/${sub.id}/target-selection`, {method:"POST",body:JSON.stringify({sourceType:"course",sourceId:"forged",sessionId:"next",selectionToken:"forged"})})).status).toBe(409);
  app.caps.external=false;
  expect((await app.request(`/subscriptions/${sub.id}/target-selection`, {method:"POST",body:"{}"})).status).toBe(403);
  app.caps.external=true;
  await env.DB.prepare("UPDATE subscriptions SET source_version=0 WHERE id=?").bind(sub.id).run();
  expect((await select(app,sub.id)).status).toBe(409);
  await env.DB.prepare("UPDATE subscriptions SET source_version=1,external_state='active',session_id=? WHERE id=?").bind(app.term.id,sub.id).run();
  expect((await select(app,sub.id)).status).toBe(409);
  expect(app.send).not.toHaveBeenCalled();
});
it("keeps all URLs inactive when external entitlement is revoked during reselection", async () => {
  const app=harness(); const sub=await expired(app);
  expect((await select(app,sub.id)).status).toBe(202);
  const captured=await app.capture(); app.capture.mockClear();
  app.capture.mockImplementationOnce(async () => {app.caps.external=false;return captured;});
  await app.consume();
  for (const token of [sub.links[0].token,sub.sharedToken]) expect((await app.request(`/calendar/${token}/calendar.ics`)).status).toBe(403);
  expect(await env.DB.prepare("SELECT external_state,is_active,manual_refresh_at FROM subscriptions WHERE id=?").bind(sub.id).first()).toEqual({external_state:"reselecting",is_active:0,manual_refresh_at:null});
});
it("keeps queue failures private and allows retry without imposing a cooldown for unsent work", async () => {
  const app=harness(); const sub=await expired(app); app.send.mockRejectedValueOnce(new Error("queue unavailable"));
  expect((await select(app,sub.id)).status).toBe(202);
  expect(await (await app.request(`/subscriptions/${sub.id}`)).json()).toMatchObject({external_state:"reselecting",sync_status:"error",sync_error_code:"QUEUE_UNAVAILABLE"});
  expect((await app.request(`/calendar/${sub.links[0].token}/calendar.ics`)).status).toBe(403);
  expect((await select(app,sub.id)).status).toBe(202); expect(app.send).toHaveBeenCalledTimes(2);
  await app.consume(); expect((await app.request(`/calendar/${sub.links[0].token}/calendar.ics`)).status).toBe(200);
});
it("never recreates a deleted subscription from an in-flight result", async () => {
  const app=harness(); const sub=await expired(app); expect((await select(app,sub.id)).status).toBe(202);
  const captured=await app.capture(); app.capture.mockClear();
  app.capture.mockImplementationOnce(async () => {
    await env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(sub.id).run(); return captured;
  });
  await app.consume();
  expect((await app.request(`/calendar/${sub.links[0].token}/calendar.ics`)).status).toBe(404);
  expect(await env.DB.prepare("SELECT count(*) AS count FROM calendar_links WHERE subscription_id=?").bind(sub.id).first()).toEqual({count:0});
});

it("pilot gate denies reselection with a valid receipt without changing the expired target", async () => {
  const app = harness(), sub = await expired(app), found = await app.classes();
  const submit = () => app.request(`/subscriptions/${sub.id}/target-selection`, { method: "POST", body: JSON.stringify({
    sourceType: "course", sourceId: "class-02", sessionId: app.term.id, selectionToken: found.selection_token,
  }) });
  app.testEnv.EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS = "fixture-other";
  const denied = await submit(); expect(denied.status).toBe(503);
  expect(await denied.json()).toMatchObject({ detail: { error: { code: "EXTERNAL_UNAVAILABLE" } } });
  expect(app.send).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT external_state,session_id,target_revision FROM subscriptions WHERE id=?").bind(sub.id).first())
    .toEqual({ external_state: "expired", session_id: "current", target_revision: 1 });
  app.testEnv.EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS = ` ${app.userId} `;
  expect((await submit()).status).toBe(202);
  await app.consume();
  expect(await env.DB.prepare("SELECT external_state,sync_status,session_id FROM subscriptions WHERE id=?").bind(sub.id).first())
    .toEqual({ external_state: "active", sync_status: "success", session_id: "next" });
});
