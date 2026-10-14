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
  const testEnv = { ...env, EXTERNAL_SUBSCRIPTION_TYPES: "course", AUTH: {
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
  async function consume() {
    await processScheduleSyncBatch({ queue: "schedule-sync", messages: [{ body: send.mock.calls[0][0], attempts: 1, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<any>, testEnv);
  }
  return { request, search, capture, send, catalog, classes, create, consume, userId, term, course, row };
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
    expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(503);
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "error", last_synced_at: null });
  }
});
