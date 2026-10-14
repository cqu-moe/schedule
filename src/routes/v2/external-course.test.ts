import { beforeAll, expect, it, vi } from "vitest";
import { applyD1Migrations, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { businessIdentity } from "../../test-utils/business-identity";
import type { SessionEnv } from "../../middleware/session";
import type { Env } from "../../types";
import worker from "../../index";
import external from "./external";
import subscriptions from "./subscriptions";
import calendar from "./calendar";
import { processScheduleSyncBatch, enqueueScheduleSync } from "../../cron/schedule-sync";

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
  const testEnv = { ...env, EXTERNAL_SUBSCRIPTION_TYPES: "course", AUTH: {
    verifySession: async () => ({ user: { id: userId, name: "测试", email: "test@example.com", role: "user" }, caps: { calendar: caps }, cquBindStatus: "active" }),
    getCaps: vi.fn().mockResolvedValue({ calendar: caps }), cquExternalSearch: search, cquExternalCapture: capture,
  }, SCHEDULE_SYNC_QUEUE: { send, sendBatch: async (messages: { body: unknown }[]) => { for (const message of messages) await send(message.body); } } } as unknown as Env;
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
  async function consume() {
    await processScheduleSyncBatch({ queue: "schedule-sync", messages: [{ body: send.mock.calls[0][0], attempts: 1, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<any>, testEnv);
  }
  return { request, search, capture, send, catalog, classes, create, consume, userId, term, course, row, testEnv, caps };
}

async function runTermCheck(app: ReturnType<typeof harness>) {
  await enqueueScheduleSync(app.testEnv);
  const messages = app.send.mock.calls.map(([body]) => body).filter(body => body.purpose === "external_term_check")
    .map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
  await processScheduleSyncBatch({ queue: "schedule-sync", messages } as unknown as MessageBatch<any>, app.testEnv);
}

it("selects course then exact teaching class and publishes ordinary and experiment events", async () => {
  const app = harness(); const created = await app.create();
  expect(app.search).toHaveBeenLastCalledWith(expect.objectContaining({ sourceType: "course", courseId: "catalog-physics", courseName: "大学物理", expectedSessionId: "current" }));
  expect(await env.DB.prepare("SELECT source_id,source_course_id,source_course_name FROM subscriptions WHERE id=?").bind(created.id).first()).toEqual({ source_id: "class-02", source_course_id: "catalog-physics", source_course_name: "大学物理" });
  await app.consume();
  expect(app.capture).toHaveBeenCalledWith(expect.objectContaining({ targetId: "class-02", targetName: "大学物理 02班", courseId: "catalog-physics", courseName: "大学物理", expectedSessionId: "current" }));
  const response = await app.request(`/calendar/${created.links[0].token}/calendar.ics`);
  expect(response.status).toBe(200); const text = await response.text();
  expect(text).toContain("实验内容：实验项目甲"); expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(4);
});

it("rejects a catalog receipt as a subscription and another owner's catalog receipt", async () => {
  const app = harness(); const catalog = await app.catalog();
  const response = await app.request("/subscriptions", { method: "POST", body: JSON.stringify({ sourceType: "course", sourceId: "catalog-physics", sourceName: "大学物理", sessionId: "current", selectionToken: catalog.selection_token }) });
  expect(response.status).toBe(409); expect(app.send).not.toHaveBeenCalled();
  const other = harness();
  expect((await other.request(`/external/teaching-classes?course_id=catalog-physics&selection_token=${catalog.selection_token}`)).status).toBe(409);
  expect(other.search).not.toHaveBeenCalled();
});

it("rejects changed semester and forged parent course in teaching-class results", async () => {
  for (const changed of [{ course: { id: "wrong", name: "其他课程" } }, { session: { id: "next", name: "下学期" } }]) {
    const app = harness(); const catalog = await app.catalog();
    app.search.mockResolvedValueOnce({ contractVersion: 1, sourceType: "course", course: app.course, session: app.term, truncated: false, items: [{ id: "class-02", name: "大学物理 02班", extra: "" }], ...changed } as any);
    expect((await app.request(`/external/teaching-classes?course_id=catalog-physics&selection_token=${catalog.selection_token}`)).status).toBe(409);
  }
});

it("never publishes another class or a late old-term capture", async () => {
  for (const changed of [{ session: { id: "next", name: "下学期", beginDate: "2027-02-22" } }, { timetable: { maxSection: 12, classTimetableVOList: [{ courseName: "其他班", classId: "class-01" }] } }]) {
    const app = harness(); const created = await app.create();
    const payload = await app.capture(); app.capture.mockClear(); app.capture.mockResolvedValueOnce({ ...payload, ...changed });
    await app.consume();
    expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(changed.session ? 403 : 503);
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "error", last_synced_at: null });
  }
});

// Auth fixtures are independent school contracts; cron/public reads own lifecycle proof.
it.each([undefined, 60])("expires all course links without requiring automatic interval %s", async (interval) => {
  const app = harness();
  Object.assign(app.caps, { external_sync_interval: interval });
  const created = await app.create(); await app.consume();
  const extra = await (await app.request(`/subscriptions/${created.id}/links`, { method: "POST", body: JSON.stringify({ formats: ["ics", "origin_json", "data_json", "csv", "web"] }) })).json<any>();
  const before = await app.request(`/calendar/${created.links[0].token}/calendar.ics`);
  expect(before.status).toBe(200); expect(before.headers.get("Cache-Control")).toBe("public, max-age=300");
  app.search.mockResolvedValue({ contractVersion: 1, sourceType: "department", session: { id: "next", name: "下学期" }, departments: [] } as any);
  await runTermCheck(app);
  const owner = await (await app.request(`/subscriptions/${created.id}`)).json<any>();
  expect(owner).toMatchObject({ external_state: "expired", sync_status: "error", sync_error_code: "EXTERNAL_TERM_EXPIRED" });
  for (const token of [created.links[0].token, extra.token]) {
    for (const path of ["calendar.ics", "origin.json", "data.json", "data.csv", "view.json"])
      expect((await app.request(`/calendar/${token}/${path}`, { headers: { "CF-Connecting-IP": `192.0.2.${Math.floor(Math.random()*200)+1}` } })).status).toBe(403);
  }
  const count = app.capture.mock.calls.length;
  await app.consume(); await runTermCheck(app);
  expect(app.capture.mock.calls.length).toBe(count);
  expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(403);
});

it("does not activate newly created share links or permit manual refresh on an expired course", async () => {
  const app = harness(); const created = await app.create(); await app.consume();
  app.search.mockResolvedValue({ contractVersion: 1, sourceType: "department", session: { id: "next", name: "下学期" }, departments: [] } as any);
  await runTermCheck(app);
  const share = await app.request(`/subscriptions/${created.id}/links`, { method: "POST", body: JSON.stringify({ formats: ["ics"] }) });
  expect(share.status).toBe(201); expect(await share.json()).toMatchObject({ is_active: false });
  const manual = await app.request(`/subscriptions/${created.id}/syncs`, { method: "POST" });
  expect(manual.status).toBe(409);
  expect(await manual.json()).toMatchObject({ detail: { error: { code: "EXTERNAL_TERM_EXPIRED" } } });
});

it("shares one term browser check between concurrent cron invocations and applies six-hour cadence", async () => {
  const app = harness(); const first = await app.create(); await app.consume();
  await env.DB.prepare(`INSERT INTO subscriptions (id,user_id,source_type,source_id,source_name,session_id,source_version,external_state,created_at,updated_at)
    VALUES (?,?,'course','second-class','第二教学班','current',1,'active',datetime('now'),datetime('now'))`).bind(crypto.randomUUID(), app.userId).run();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const search = vi.fn(async () => { await gate; return { contractVersion: 1, sourceType: "department", session: app.term, departments: [] }; });
  app.testEnv.AUTH.cquExternalSearch = search as any;
  const one = runTermCheck(app);
  await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
  await runTermCheck(app); release(); await one;
  expect(search).toHaveBeenCalledOnce();
  await runTermCheck(app); expect(search).toHaveBeenCalledOnce();
  expect((await app.request(`/calendar/${first.links[0].token}/calendar.ics`)).status).toBe(200);
  const base = Date.now(); const clock = vi.spyOn(Date, "now");
  try {
    clock.mockReturnValue(base + 6 * 60 * 60_000 - 60_000);
    await runTermCheck(app); expect(search).toHaveBeenCalledOnce();
    clock.mockReturnValue(base + 6 * 60 * 60_000 + 60_000);
    await runTermCheck(app); expect(search).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it.each([{ error: "BROWSER_BUSY" }, { contractVersion: 1, sourceType: "department", session: { id: "", name: "未知" }, departments: [] }])("retains a current course on unknown term and cools down failures: %j", async (unknown) => {
  const app = harness(); const created = await app.create(); await app.consume();
  const search = vi.fn().mockResolvedValue(unknown); app.testEnv.AUTH.cquExternalSearch = search;
  await runTermCheck(app); await runTermCheck(app);
  expect(search).toHaveBeenCalledOnce();
  expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ external_state: "active" });
  expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(200);
});

it("does not publish or restore links when expiration wins during an in-flight capture", async () => {
  const app = harness(); const created = await app.create();
  const payload = await app.capture(); app.capture.mockClear();
  let release!: (value: any) => void;
  app.capture.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const running = app.consume();
  await vi.waitFor(() => expect(app.capture).toHaveBeenCalledOnce());
  app.search.mockResolvedValue({ contractVersion: 1, sourceType: "department", session: { id: "next", name: "下学期" }, departments: [] } as any);
  await runTermCheck(app); release(payload); await running;
  expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ external_state: "expired", last_synced_at: null, sync_error_code: "EXTERNAL_TERM_EXPIRED" });
  expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(403);
});

it("expires a reselecting course when another trusted semester arrives", async () => {
  const app = harness(); const created = await app.create();
  await env.DB.prepare("UPDATE subscriptions SET external_state='reselecting',is_active=0 WHERE id=?").bind(created.id).run();
  app.search.mockResolvedValue({ contractVersion: 1, sourceType: "department", session: { id: "next", name: "下学期" }, departments: [] } as any);
  await runTermCheck(app);
  expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ external_state: "expired", sync_error_code: "EXTERNAL_TERM_EXPIRED" });
});

it("keeps expired courses and every link disabled after external and share rights restoration", async () => {
  const app = harness(); const created = await app.create(); await app.consume();
  app.search.mockResolvedValue({ contractVersion: 1, sourceType: "department", session: { id: "next", name: "下学期" }, departments: [] } as any);
  await runTermCheck(app);
  Object.assign(app.caps, { external: false, share: false }); await runTermCheck(app);
  Object.assign(app.caps, { external: true, share: true }); await runTermCheck(app);
  const owner = await (await app.request(`/subscriptions/${created.id}`)).json<any>();
  expect(owner.external_state).toBe("expired"); expect(owner.links.every((link: any) => link.is_active === false)).toBe(true);
});

it("expires rather than publishing a validated course capture from a different current term", async () => {
  const app = harness(); const created = await app.create();
  const payload = await app.capture(); app.capture.mockResolvedValue({ ...payload, session: { id: "next", name: "下学期", beginDate: "2027-02-22" } });
  await app.consume();
  expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ external_state: "expired", last_synced_at: null });
  expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(403);
});

it("does not expire a newly reselected revision when an older term check replies late", async () => {
  const app = harness(); const created = await app.create();
  let release!: (value: any) => void;
  const search = vi.fn(() => new Promise(resolve => { release = resolve; }));
  app.testEnv.AUTH.cquExternalSearch = search as any;
  const checking = runTermCheck(app);
  await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
  // Target-selection fixture models the independently owned T11 transaction.
  await env.DB.prepare(`UPDATE subscriptions SET source_id='reselected-class',session_id='new-selected-term',
    target_revision=target_revision+1,external_state='reselecting',is_active=0 WHERE id=?`).bind(created.id).run();
  release({ contractVersion: 1, sourceType: "department", session: { id: "older-current", name: "旧检查学期" }, departments: [] });
  await checking;
  expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ source_id: "reselected-class", session_id: "new-selected-term", external_state: "reselecting" });
});

it("scheduled entry enqueues a term check without opening a school browser", async () => {
  const app = harness(); const created = await app.create();
  const search = vi.fn().mockResolvedValue({ contractVersion: 1, sourceType: "department", session: { id: "next", name: "新学期" }, departments: [] });
  app.testEnv.AUTH.cquExternalSearch = search;
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledController, app.testEnv, ctx);
  await waitOnExecutionContext(ctx);
  expect(search).not.toHaveBeenCalled();
  expect(app.send.mock.calls.map(([body]) => body)).toContainEqual(expect.objectContaining({ purpose: "external_term_check", userId: app.userId }));
  await runTermCheck(app);
  expect(search).toHaveBeenCalledOnce();
  expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ external_state: "expired" });
});

it("releases a failed term-check enqueue and retries after a bounded five-minute cooldown", async () => {
  const app = harness(); await app.create();
  const sendBatch = vi.fn().mockRejectedValue(new Error("queue unavailable"));
  app.testEnv.SCHEDULE_SYNC_QUEUE.sendBatch = sendBatch;
  await enqueueScheduleSync(app.testEnv); await enqueueScheduleSync(app.testEnv);
  expect(sendBatch).toHaveBeenCalledOnce();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
  try { await enqueueScheduleSync(app.testEnv); expect(sendBatch).toHaveBeenCalledTimes(2); }
  finally { clock.mockRestore(); }
});
