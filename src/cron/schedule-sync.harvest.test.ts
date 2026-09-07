import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { notificationState, subscriptions } from "../db/schema";
import { processScheduleSyncBatch, type ScheduleSyncMessage } from "./schedule-sync";
import * as harvestModule from "../services/cqu-harvest";
import { HarvestError } from "../services/cqu-harvest";
import type { Env } from "../types";
import { hashSchedule, normalizeSchedule } from "../services/schedule-notifications";

const db = drizzle(env.DB);

const FULL_CAPS = {
  sync: true, external: true, share: true,
  change_notification: true,
  sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
};

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();
  await env.DB.prepare(
    `CREATE TABLE subscriptions (
      id text PRIMARY KEY NOT NULL, user_id text NOT NULL, source_type text NOT NULL,
      source_id text NOT NULL, source_name text NOT NULL, session_id text, session_name text,
      semester_start text, is_personal integer NOT NULL DEFAULT 0, is_active integer NOT NULL DEFAULT 1,
      ics_content text, courses_json text, exams_json text, last_synced_at text,
      sync_status text NOT NULL DEFAULT 'idle', sync_run_id text, sync_trigger text,
      sync_requested_at text, sync_started_at text, sync_finished_at text,
      sync_error_code text, sync_error_message text,
      manual_refresh_at text,
      created_at text NOT NULL, updated_at text NOT NULL
    )`,
  ).run();
  await env.DB.prepare("DROP TABLE IF EXISTS notification_state").run();
  await env.DB.prepare(
    `CREATE TABLE notification_state (
      user_id text PRIMARY KEY NOT NULL, enabled integer NOT NULL DEFAULT 0,
      snapshot_json text, snapshot_hash text,
      created_at text NOT NULL, updated_at text NOT NULL
    )`,
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM subscriptions").run();
  await env.DB.prepare("DELETE FROM notification_state").run();
  await env.CACHE.put("caps:user-1", JSON.stringify(FULL_CAPS));
});

afterEach(() => vi.restoreAllMocks());

async function insertSub(overrides: Partial<typeof subscriptions.$inferInsert> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(subscriptions).values({
    id, userId: "user-1", sourceType: "personal_all", sourceId: "user-1",
    sourceName: "我的课表", createdAt: now, updatedAt: now, ...overrides,
  });
  return id;
}

function makeBatch(bodies: ScheduleSyncMessage[], attempts = 1) {
  const messages = bodies.map((body) => ({ body, attempts, ack: vi.fn(), retry: vi.fn() }));
  return { batch: { queue: "schedule-sync", messages } as unknown as MessageBatch<ScheduleSyncMessage>, messages };
}

function testEnv(send = vi.fn().mockResolvedValue(undefined)): Env {
  return { ...env, SCHEDULE_NOTIFICATION_QUEUE: { send } } as unknown as Env;
}

describe("processScheduleSyncBatch — organic harvest personal path", () => {
  it("stores the first successful harvest as a baseline without sending", async () => {
    const sid = await insertSub();
    const send = vi.fn();
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2026秋", begin_date: "2026-09-07", end_date: "2027-01-15" } },
      data: { courses: [{ name: "高等数学", lecturer: "张老师", room: "A101", position: "A101", day_of_week: 2, start_session: 1, end_session: 2, weeks: [1] }], exams: [], semesterStart: "2026-09-07" },
    });

    const { batch } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, testEnv(send));

    expect(send).not.toHaveBeenCalled();
    const state = await db.select().from(notificationState).where(eq(notificationState.userId, "user-1")).get();
    expect(state?.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enqueues one merged notification for the personal trio and advances the baseline", async () => {
    const allSid = await insertSub({ sourceType: "personal_all", sourceName: "全部" });
    const coursesSid = await insertSub({ sourceType: "personal_courses", sourceName: "课程" });
    const examsSid = await insertSub({ sourceType: "personal_exams", sourceName: "考试" });
    const oldData = { courses: [{ name: "高等数学", lecturer: "张老师", room: "A101", position: "A101", day_of_week: 2, start_session: 1, end_session: 2, weeks: [1] }], exams: [{ name: "大学物理", room: "D1137", seat: 18, start_time: "2026-09-10T01:00:00.000Z", end_time: "2026-09-10T03:00:00.000Z" }], semesterStart: "2026-09-07" };
    const oldSnapshot = normalizeSchedule(oldData);
    const oldHash = await hashSchedule(oldSnapshot);
    await db.insert(notificationState).values({
      userId: "user-1", enabled: true, snapshotJson: JSON.stringify(oldSnapshot), snapshotHash: oldHash,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const newData = {
      ...oldData,
      courses: [{ ...oldData.courses[0], room: "A102", position: "A102" }],
      exams: [{ ...oldData.exams[0], seat: 20 }],
    };
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2026秋", begin_date: "2026-09-07", end_date: "2027-01-15" } },
      data: newData,
    });
    const send = vi.fn().mockResolvedValue(undefined);

    const { batch } = makeBatch([
      { subscriptionId: allSid, userId: "user-1" },
      { subscriptionId: coursesSid, userId: "user-1" },
      { subscriptionId: examsSid, userId: "user-1" },
    ]);
    await processScheduleSyncBatch(batch, testEnv(send));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      userId: "user-1",
      subject: "课表与考试安排有更新（2项）",
      html: expect.stringContaining("9 月 8 日"),
      text: expect.stringContaining("考试安排"),
    }));
    expect(send.mock.calls[0][0]).not.toHaveProperty("email");
    const state = await db.select().from(notificationState).where(eq(notificationState.userId, "user-1")).get();
    expect(state?.snapshotHash).toBe(await hashSchedule(normalizeSchedule(newData)));
  });

  it("keeps the old baseline when notification enqueue fails while the sync still succeeds", async () => {
    const sid = await insertSub();
    const oldData = { courses: [{ name: "高等数学", lecturer: "张老师", room: "A101", position: "A101", day_of_week: 2, start_session: 1, end_session: 2, weeks: [1] }], exams: [], semesterStart: "2026-09-07" };
    const oldSnapshot = normalizeSchedule(oldData);
    const oldHash = await hashSchedule(oldSnapshot);
    await db.insert(notificationState).values({
      userId: "user-1", enabled: true, snapshotJson: JSON.stringify(oldSnapshot), snapshotHash: oldHash,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2026秋", begin_date: "2026-09-07", end_date: "2027-01-15" } },
      data: { ...oldData, courses: [{ ...oldData.courses[0], room: "A102" }] },
    });
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);

    await processScheduleSyncBatch(batch, testEnv(send));

    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    const state = await db.select().from(notificationState).where(eq(notificationState.userId, "user-1")).get();
    expect(state?.snapshotHash).toBe(oldHash);
    const sub = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(sub?.syncStatus).toBe("success");
  });
  it("syncs a personal sub via fetchPersonalHarvest (no bearer)", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(harvest).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.coursesJson).toBe("[]");
    expect(row.icsContent).toContain("BEGIN:VCALENDAR");
    expect(row.sessionName).toBe("2025秋");
  });

  it("harvests once for multiple personal subscriptions of the same user in one batch", async () => {
    const allSid = await insertSub({ sourceType: "personal_all", sourceName: "全部" });
    const coursesSid = await insertSub({ sourceType: "personal_courses", sourceName: "课程" });
    const examsSid = await insertSub({ sourceType: "personal_exams", sourceName: "考试" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch, messages } = makeBatch([
      { subscriptionId: allSid, userId: "user-1" },
      { subscriptionId: coursesSid, userId: "user-1" },
      { subscriptionId: examsSid, userId: "user-1" },
    ]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(harvest).toHaveBeenCalledTimes(1);
    expect(messages.every(message => message.ack.mock.calls.length === 1)).toBe(true);
    expect(messages.every(message => message.retry.mock.calls.length === 0)).toBe(true);
  });

  it("syncing any one personal subscription updates the entire personal trio", async () => {
    const allSid = await insertSub({ sourceType: "personal_all", sourceName: "全部" });
    const coursesSid = await insertSub({ sourceType: "personal_courses", sourceName: "课程" });
    const examsSid = await insertSub({ sourceType: "personal_exams", sourceName: "考试" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch, messages } = makeBatch([{ subscriptionId: coursesSid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(harvest).toHaveBeenCalledTimes(1);
    expect(messages[0].ack).toHaveBeenCalledOnce();
    const rows = await db.select().from(subscriptions);
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([allSid, coursesSid, examsSid]));
    expect(rows.every(row => row.lastSyncedAt !== null)).toBe(true);
    expect(rows.every(row => row.icsContent?.includes("BEGIN:VCALENDAR"))).toBe(true);
  });

  it("retries a transient HarvestError with backoff", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(
      new HarvestError("ATRUST_TRANSIENT"),
    );

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("persists a safe error after transient HarvestError retries are exhausted", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(
      new HarvestError("CQU_WAF_BLOCKED"),
    );

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }], 4);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull(); // not synced
    const state = await env.DB.prepare(
      "SELECT sync_status, sync_error_code, sync_error_message FROM subscriptions WHERE id = ?",
    ).bind(sid).first<{ sync_status: string; sync_error_code: string; sync_error_message: string }>();
    expect(state).toEqual({
      sync_status: "error",
      sync_error_code: "CQU_WAF_BLOCKED",
      sync_error_message: "学校系统暂时无法完成同步，请稍后重试",
    });
  });

  it("retries on a generic (non-harvest) error", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new Error("boom"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("acks-skips an external sub (no harvest path: 冻结,不删数据,不取数)", async () => {
    const sid = await insertSub({ sourceType: "instructor", sourceId: "T-42", isPersonal: false });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull(); // frozen, not synced, not deleted
  });
});
