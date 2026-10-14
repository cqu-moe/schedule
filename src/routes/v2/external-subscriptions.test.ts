import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { businessIdentity } from "../../test-utils/business-identity";
import type { SessionEnv } from "../../middleware/session";
import type { CalendarCaps } from "../../services/auth-rpc";
import type { Env } from "../../types";
import { resetPersonalData, seedPersonal } from "../../../tests/fixtures/personal-subscriptions";
import external from "./external";
import subscriptions from "./subscriptions";
import calendar from "./calendar";
import { processScheduleSyncBatch } from "../../cron/schedule-sync";
import type { ScheduleSyncMessage } from "../../cron/schedule-sync";
import worker from "../../index";

const CAPS: CalendarCaps = { sync: true, external: true, share: true, change_notification: false,
  sub_limit: 1, share_limit: 5, sync_interval: 60, manual_refresh: 5 };
const TARGET = { id: "admin-one", name: "测试行政班", extra: "2026级" };
const TERM = { id: "term-current", name: "2026秋" };
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => resetPersonalData(env.DB));

function makeApp(userId = crypto.randomUUID(), caps = CAPS) {
  const send = vi.fn().mockResolvedValue(undefined);
  const capture = vi.fn();
  const app = new Hono<SessionEnv>();
  app.use("/search/*", businessIdentity);
  app.use("/subscriptions/*", businessIdentity);
  app.route("/search", external);
  app.route("/subscriptions", subscriptions);
  app.route("/calendar", calendar);
  const testEnv = { ...env, PERSONAL_SUBSCRIPTION_MODE: "legacy", EXTERNAL_SUBSCRIPTION_TYPES: "admin_class",
    AUTH: {
      verifySession: async () => ({ user: { id: userId, name: "测试", email: "test@example.com", role: "user" }, caps: { calendar: caps }, cquBindStatus: "active" }),
      getCquTicket: vi.fn().mockResolvedValue({ error: "NOT_USED" }),
      getCaps: vi.fn().mockResolvedValue({ calendar: caps }),
      cquExternalSearch: vi.fn().mockResolvedValue({ contractVersion: 1, sourceType: "admin_class", session: TERM, items: [TARGET], truncated: false }),
      cquExternalCapture: capture,
    },
    SCHEDULE_SYNC_QUEUE: { send },
  } as unknown as Env;
  let selectionToken: string | undefined;
  return { userId, send, capture, testEnv,
    request: (path: string, init?: RequestInit) => app.request(path, init, testEnv),
    async select() { const response = await app.request("/search/search?source_type=admin_class&keyword=测试", {}, testEnv); expect(response.status).toBe(200); selectionToken = (await response.json<any>()).selection_token; return selectionToken; },
    create: (changes = {}) => app.request("/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceType: "admin_class", sourceId: TARGET.id, sourceName: TARGET.name, sessionId: TERM.id, selectionToken, ...changes }) }, testEnv),
  };
}

describe("new external subscription first capture", () => {
  it("creates a persistent queued subscription despite a legacy duplicate and a managed personal row", async () => {
    const app = makeApp();
    await seedPersonal(env.DB, app.userId);
    await env.DB.prepare(`INSERT INTO subscriptions (id,user_id,source_type,source_id,source_name,session_id,created_at,updated_at)
      VALUES ('legacy',?,'admin_class',?,?,?,datetime('now'),datetime('now'))`)
      .bind(app.userId, TARGET.id, TARGET.name, TERM.id).run();
    await app.select();
    const response = await app.create({ sourceName: "客户端不可信名称" });
    expect(response.status).toBe(201);
    const body = await response.json<any>();
    expect(body).toMatchObject({ source_version: 1, source_name: TARGET.name, sync_status: "queued", last_synced_at: null });
    expect(app.capture).not.toHaveBeenCalled();
    expect(app.send).toHaveBeenCalledOnce();
    expect(app.send).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: body.id, sourceVersion: 1, targetRevision: 0, trigger: "initial", runId: body.sync_run_id }));
    expect((await env.DB.prepare("SELECT id FROM subscriptions WHERE id='legacy'").first())?.id).toBe("legacy");
    const publicResponse = await app.request(`/calendar/${body.links[0].token}/calendar.ics`);
    expect(publicResponse.status).toBe(503);
    expect(await publicResponse.json()).toMatchObject({ detail: { error: { code: "INITIAL_SYNC_PENDING" } } });
  });

  it("publishes a validated first capture and ignores repeated queue delivery", async () => {
    const app = makeApp();
    await app.select();
    const created = await (await app.create()).json<any>();
    app.capture.mockResolvedValue({ contractVersion: 1, sourceType: "admin_class", target: TARGET,
      session: { ...TERM, beginDate: "2026-09-07" }, timetable: { maxSection: 14, classTimetableVOList: [{
        courseName: "电路基础", instructorName: "测试教师", roomName: "DS1001", weekDay: 1,
        teachingWeek: "11", period: "11000000000000", assignTeachingObject: [{ adminClassId: TARGET.id }],
      }] } });
    const message = { body: app.send.mock.calls[0][0], attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const batch = { queue: "schedule-sync", messages: [message] } as unknown as MessageBatch<any>;
    await processScheduleSyncBatch(batch, app.testEnv);
    const read = await app.request(`/calendar/${created.links[0].token}/calendar.ics`);
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("SUMMARY:电路基础");
    expect(app.capture).toHaveBeenCalledOnce();
    await processScheduleSyncBatch(batch, app.testEnv);
    expect(app.capture).toHaveBeenCalledOnce();
    const owner = await (await app.request(`/subscriptions/${created.id}`)).json<any>();
    expect(owner).toMatchObject({ sync_status: "success", import_quality: "complete", skipped_count: 0 });
    expect(app.testEnv.AUTH.getCquTicket).not.toHaveBeenCalled();
  });

  it("refreshes a due external subscription through the real cron and queue entrypoints", async () => {
    const app = makeApp("cron-user", { ...CAPS, external_sync_interval: 15 });
    let calendarReads = 0;
    const readCalendar = (token: string) => {
      calendarReads += 1;
      return app.request(`/calendar/${token}/calendar.ics`, {
        headers: { "CF-Connecting-IP": `203.0.113.${calendarReads}` },
      });
    };
    await app.select();
    const created = await (await app.create()).json<any>();
    app.capture.mockResolvedValue(successfulCapture());
    const initialBody = app.send.mock.calls[0][0];
    const initialMessage = { body: initialBody, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const initialContext = createExecutionContext();
    await worker.queue(
      { queue: "schedule-sync", messages: [initialMessage] } as unknown as MessageBatch<any>,
      app.testEnv,
      initialContext,
    );
    await waitOnExecutionContext(initialContext);
    expect(await (await readCalendar(created.links[0].token)).text())
      .toContain("SUMMARY:电路基础");

    await env.DB.prepare("UPDATE subscriptions SET last_synced_at=? WHERE id=?")
      .bind(new Date(Date.now() - 16 * 60_000).toISOString(), created.id)
      .run();
    app.capture.mockResolvedValue(successfulCapture([{
      courseName: "自动更新课程", instructorName: "测试教师", roomName: "DS1002", weekDay: 2,
      teachingWeek: "11", period: "11000000000000", assignTeachingObject: [{ adminClassId: TARGET.id }],
    }]));
    let cronMessages: Array<{ body: ScheduleSyncMessage; delaySeconds: number }> = [];
    const sendBatch = vi.fn(async (messages: Array<{ body: ScheduleSyncMessage }>) => {
      cronMessages = messages;
    });
    app.testEnv.SCHEDULE_SYNC_QUEUE = { send: app.send, sendBatch } as unknown as Env["SCHEDULE_SYNC_QUEUE"];
    const firstContext = createExecutionContext();
    const secondContext = createExecutionContext();
    await Promise.all([
      worker.scheduled({ cron: "*/15 * * * *" } as ScheduledController, app.testEnv, firstContext),
      worker.scheduled({ cron: "*/15 * * * *" } as ScheduledController, app.testEnv, secondContext),
    ]);
    await waitOnExecutionContext(firstContext);
    await waitOnExecutionContext(secondContext);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(cronMessages).toHaveLength(1);
    expect(cronMessages[0]).toEqual({
      body: {
        subscriptionId: created.id,
        userId: "cron-user",
        sourceVersion: 1,
        targetRevision: 0,
        trigger: "cron",
        runId: expect.any(String),
      },
      delaySeconds: 0,
    });
    const cronMessage = {
      body: cronMessages[0].body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const cronContext = createExecutionContext();
    await worker.queue(
      { queue: "schedule-sync", messages: [cronMessage] } as unknown as MessageBatch<any>,
      app.testEnv,
      cronContext,
    );
    await waitOnExecutionContext(cronContext);

    const calendar = await (await readCalendar(created.links[0].token)).text();
    expect(calendar).toContain("SUMMARY:自动更新课程");
    expect(calendar).not.toContain("SUMMARY:电路基础");
    expect(await env.DB.prepare(
      "SELECT sync_trigger,manual_refresh_at,sync_error_code FROM subscriptions WHERE id=?",
    ).bind(created.id).first()).toEqual({
      sync_trigger: "cron",
      manual_refresh_at: null,
      sync_error_code: null,
    });
    expect(cronMessage.ack).toHaveBeenCalledOnce();
    expect(app.testEnv.AUTH.getCquTicket).not.toHaveBeenCalled();
  });

});

function successfulCapture(rows: unknown[] = [{ courseName: "电路基础", instructorName: "测试教师", roomName: "DS1001", weekDay: 1,
  teachingWeek: "11", period: "11000000000000", assignTeachingObject: [{ adminClassId: TARGET.id }] }]) {
  return { contractVersion: 1, sourceType: "admin_class", target: TARGET, session: { ...TERM, beginDate: "2026-09-07" }, timetable: { maxSection: 14, classTimetableVOList: rows } };
}
async function consume(app: ReturnType<typeof makeApp>, changes: Record<string, unknown> = {}, attempts = 1) {
  const message = { body: { ...app.send.mock.calls[0][0], ...changes }, attempts, ack: vi.fn(), retry: vi.fn() };
  await processScheduleSyncBatch({ queue: "schedule-sync", messages: [message] } as unknown as MessageBatch<any>, app.testEnv);
  return message;
}

describe("external admission and publication boundaries", () => {
  it("rejects unsearched, foreign-owner, historical-term and altered targets", async () => {
    const app = makeApp(), other = makeApp();
    const foreignToken = await other.select();
    for (const changes of [{}, { selectionToken: foreignToken }]) expect((await app.create(changes)).status).toBe(409);
    await app.select();
    for (const changes of [{ sessionId: "previous-term" }, { sourceId: "not-in-results" }]) expect((await app.create(changes)).status).toBe(409);
    expect(app.send).not.toHaveBeenCalled();
    expect(app.capture).not.toHaveBeenCalled();
  });

  it("admits only one concurrent duplicate and preserves failed queue admission for retry", async () => {
    const app = makeApp(); await app.select();
    app.send.mockRejectedValue(new Error("queue offline secret"));
    const responses = await Promise.all([app.create(), app.create()]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const created = await responses.find(r => r.status === 201)!.json<any>();
    expect(created).toMatchObject({ sync_status: "error", sync_error_code: "QUEUE_UNAVAILABLE", source_version: 1 });
    expect(JSON.stringify(created)).not.toContain("secret");
    expect(app.send).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT count(*) n FROM calendar_links WHERE subscription_id=?").bind(created.id).first("n")).toBe(1);
  });

  it("publishes valid empty with an explicit owner state and keeps partial separate", async () => {
    const app = makeApp(); await app.select(); const created = await (await app.create()).json<any>();
    app.capture.mockResolvedValue(successfulCapture([]));
    await consume(app);
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ import_quality: "empty", sync_status: "success" });
    expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(200);
    await env.DB.prepare("UPDATE subscriptions SET sync_status='queued', sync_run_id='second' WHERE id=?").bind(created.id).run();
    app.capture.mockResolvedValue(successfulCapture([...successfulCapture().timetable.classTimetableVOList, { courseName: "无时间", assignTeachingObject: [{ adminClassId: TARGET.id }] }]));
    await consume(app, { runId: "second" });
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ import_quality: "partial", skipped_count: 1, sync_status: "success" });
  });

  it("keeps the last successful snapshot on malformed or forbidden refresh", async () => {
    const app = makeApp(); await app.select(); const created = await (await app.create()).json<any>();
    app.capture.mockResolvedValue(successfulCapture()); await consume(app);
    const previous = await env.DB.prepare("SELECT ics_content,courses_json,last_synced_at FROM subscriptions WHERE id=?").bind(created.id).first();
    for (const response of [{ error: "PAGE_PERMISSION_DENIED" }, { ...successfulCapture(), target: { id: "wrong", name: "wrong" } }]) {
      const runId = crypto.randomUUID();
      await env.DB.prepare("UPDATE subscriptions SET sync_status='queued',sync_run_id=? WHERE id=?").bind(runId, created.id).run();
      app.capture.mockResolvedValue(response); await consume(app, { runId });
      expect(await env.DB.prepare("SELECT ics_content,courses_json,last_synced_at FROM subscriptions WHERE id=?").bind(created.id).first()).toEqual(previous);
      expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "error" });
    }
  });

  it("does not publish after authority is revoked during capture", async () => {
    const app = makeApp(); await app.select(); const created = await (await app.create()).json<any>();
    vi.mocked(app.testEnv.AUTH.getCaps!).mockResolvedValueOnce({ calendar: CAPS }).mockResolvedValue({ calendar: { ...CAPS, external: false, share: false } });
    app.capture.mockResolvedValue(successfulCapture()); await consume(app);
    expect(await env.DB.prepare("SELECT sync_status,is_active,last_synced_at,ics_content FROM subscriptions WHERE id=?").bind(created.id).first()).toMatchObject({ sync_status: "error", is_active: 0, last_synced_at: null, ics_content: null });
    expect((await app.request(`/calendar/${created.links[0].token}/calendar.ics`)).status).toBe(403);
  });

  it("rejects stale revisions and protects an in-flight replacement", async () => {
    const app = makeApp(); await app.select(); const created = await (await app.create()).json<any>();
    await consume(app, { targetRevision: 1 }); expect(app.capture).not.toHaveBeenCalled();
    app.capture.mockImplementation(async () => {
      await env.DB.prepare("UPDATE subscriptions SET target_revision=1,sync_run_id='replacement',sync_status='queued' WHERE id=?").bind(created.id).run();
      return successfulCapture();
    });
    await consume(app);
    expect(await env.DB.prepare("SELECT target_revision,sync_run_id,sync_status,last_synced_at FROM subscriptions WHERE id=?").bind(created.id).first()).toEqual({ target_revision: 1, sync_run_id: "replacement", sync_status: "queued", last_synced_at: null });
  });

  it("bounds transient retries and never consumes the personal source", async () => {
    const app = makeApp(); await app.select(); const created = await (await app.create()).json<any>();
    app.capture.mockResolvedValue({ error: "BROWSER_BUSY" });
    const first = await consume(app); expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    const final = await consume(app, {}, 3); expect(final.retry).not.toHaveBeenCalled(); expect(final.ack).toHaveBeenCalledOnce();
    expect(await (await app.request(`/subscriptions/${created.id}`)).json()).toMatchObject({ sync_status: "error", sync_error_code: "EXTERNAL_SYNC_UNAVAILABLE" });
    expect(app.testEnv.AUTH.getCquTicket).not.toHaveBeenCalled();
  });
});
