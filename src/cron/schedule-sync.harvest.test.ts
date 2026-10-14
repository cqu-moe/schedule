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
import * as telemetry from "../lib/posthog";

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
      source_version integer NOT NULL DEFAULT 0,
      external_state text NOT NULL DEFAULT 'active',
      target_revision integer NOT NULL DEFAULT 0,
      import_quality text,
      skipped_count integer NOT NULL DEFAULT 0,
      id text PRIMARY KEY NOT NULL, user_id text NOT NULL, source_type text NOT NULL,
      source_id text NOT NULL, source_name text NOT NULL, session_id text, session_name text,
      semester_start text, is_personal integer NOT NULL DEFAULT 0, is_active integer NOT NULL DEFAULT 1,
      ics_content text, courses_json text, exams_json text, last_synced_at text,
      sync_status text NOT NULL DEFAULT 'idle', sync_run_id text, sync_trigger text,
      sync_requested_at text, sync_started_at text, sync_finished_at text,
      sync_error_code text, sync_error_message text,
      session_recovery_attempts integer NOT NULL DEFAULT 0,
      manual_refresh_at text,
      created_at text NOT NULL, updated_at text NOT NULL
    )`,
  ).run();
  await env.DB.prepare("DROP TABLE IF EXISTS notification_state").run();
  await env.DB.prepare(
    `CREATE TABLE notification_state (
      user_id text PRIMARY KEY NOT NULL, enabled integer NOT NULL DEFAULT 0,
      snapshot_json text, snapshot_hash text, pending_notification_json text,
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

// ── 未来时间锚定 ────────────────────────────────────────────────────────────
// 通知邮件只包含「未来时间的变化」——固定日期的测试数据会随真实日期推移变成
// 过去时而被过滤(2026-09-09 起硬编码的 "9 月 8 日" 即失效)。这里把课程/考试
// 时间锚定到「今天 + N 天」,保证测试在任何日期运行语义一致。

const CHINA_TZ = "Asia/Shanghai";
const DAY_MS = 24 * 3600_000;

/** 中国时区下某时刻的年/月/日/星期(1=周一 … 7=周日)。 */
function chinaDateParts(date: Date): { year: number; month: number; day: number; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHINA_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    dayOfWeek: weekdays[get("weekday")],
  };
}

/**
 * 课程锚定在中国时区「今天 + daysAhead」:semesterStart 取该日所在周的周一,
 * day_of_week 即该日的星期,weeks=[1] 使课程恰好落在该日(必为未来)。
 */
function futureCourseFixture(daysAhead = 3) {
  const targetMs = Date.now() + daysAhead * DAY_MS;
  const target = chinaDateParts(new Date(targetMs));
  const monday = chinaDateParts(new Date(targetMs - (target.dayOfWeek - 1) * DAY_MS));
  const iso = (p: { year: number; month: number; day: number }) =>
    `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return {
    semesterStart: iso(monday),
    dayOfWeek: target.dayOfWeek,
    /** 与邮件渲染相同的「M 月 D 日」标签,用于断言。 */
    dateLabel: `${target.month}月${target.day}日`,
  };
}

/** 未来某天的考试起止时刻(09:00–11:00 中国时区 = 01:00–03:00 UTC)。 */
function futureExamTimes(daysAhead = 4) {
  const day = chinaDateParts(new Date(Date.now() + daysAhead * DAY_MS));
  const iso = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  return { start_time: `${iso}T01:00:00.000Z`, end_time: `${iso}T03:00:00.000Z` };
}

describe("processScheduleSyncBatch — organic harvest personal path", () => {
  it("reports execution from the accepted running timestamp separately from the full run age", async () => {
    const requestedAt = 1_800_000_000_000;
    let now = requestedAt + 40_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: new Date(requestedAt).toISOString(), sessionRecoveryAttempts: 1,
    });
    const capture = vi.spyOn(telemetry, "captureScheduleEvent");
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockImplementation(async () => {
      now += 70_000;
      return {
        ctx: { sessionId: "term-1", semesterInfo: { id: "term-1", name: "2026秋", begin_date: "2026-09-01", end_date: "2027-01-31" } },
        data: { courses: [], exams: [], semesterStart: "2026-09-01" },
      };
    });
    const { batch } = makeBatch([{
      subscriptionId: sid, userId: "user-1", runId, trigger: "cron",
    }], 3);

    await processScheduleSyncBatch(batch, { ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled" });
    await processScheduleSyncBatch(batch, { ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled" });

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(expect.anything(), undefined, "schedule_sync_completed", "user-1", expect.objectContaining({
      outcome: "success", duration_ms: 70_000, end_to_end_duration_ms: 110_000,
      duration_basis: "execution_v2", delivery_attempt: 3,
      session_recovery_attempts: 1,
    }));
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row?.syncStartedAt).toBe(new Date(requestedAt + 40_000).toISOString());
    expect(capture.mock.calls[0][4]).not.toHaveProperty("attempt_duration_ms");
  });

  it("harvests and commits one canonical row for all built-in views", async () => {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal",
      sourceId: "user-1",
      syncStatus: "queued",
      syncRunId: runId,
      syncTrigger: "manual",
      syncRequestedAt: new Date().toISOString(),
    });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: {
        sessionId: "term-1",
        semesterInfo: {
          id: "term-1",
          name: "测试学期",
          begin_date: "2026-09-01",
          end_date: "2027-01-31",
        },
      },
      data: { courses: [], exams: [], semesterStart: "2026-09-01" },
    });
    const { batch, messages } = makeBatch([
      { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" },
      { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" },
    ]);

    await processScheduleSyncBatch(batch, {
      ...testEnv(),
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });

    expect(harvest).toHaveBeenCalledTimes(1);
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row?.syncStatus).toBe("success");
    expect(row?.coursesJson).toBe("[]");
    expect(messages.filter((message) => message.ack.mock.calls.length === 1)).toHaveLength(1);
    expect(messages.filter((message) => message.retry.mock.calls.length === 1)).toHaveLength(1);
  });

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
    const fixture = futureCourseFixture();
    const oldData = { courses: [{ name: "高等数学", lecturer: "张老师", room: "A101", position: "A101", day_of_week: fixture.dayOfWeek, start_session: 1, end_session: 2, weeks: [1] }], exams: [{ name: "大学物理", room: "D1137", seat: 18, ...futureExamTimes() }], semesterStart: fixture.semesterStart };
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
      html: expect.stringContaining(fixture.dateLabel),
      text: expect.stringContaining("考试安排"),
    }));
    expect(send.mock.calls[0][0]).not.toHaveProperty("email");
    const state = await db.select().from(notificationState).where(eq(notificationState.userId, "user-1")).get();
    expect(state?.snapshotHash).toBe(await hashSchedule(normalizeSchedule(newData)));
  });

  it("retries the exact persisted multi-email batch after a partial enqueue failure", async () => {
    const sid = await insertSub();
    const fixture = futureCourseFixture();
    const oldData = { semesterStart: fixture.semesterStart, exams: [], courses: Array.from({length:40}, (_,index)=>({name:`课程${index}`,lecturer:"张老师",position:"虎溪校区",room:"D123",day_of_week:3,start_session:1,end_session:2,weeks:Array.from({length:18},(_,week)=>week+1)})) };
    const oldSnapshot=normalizeSchedule(oldData);
    await db.insert(notificationState).values({userId:"user-1",enabled:true,snapshotJson:JSON.stringify(oldSnapshot),snapshotHash:await hashSchedule(oldSnapshot),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    const newData={...oldData,courses:oldData.courses.map(item=>({...item,day_of_week:5}))};
    vi.spyOn(harvestModule,"fetchPersonalHarvest").mockResolvedValue({ctx:{sessionId:"sess-1",semesterInfo:{id:"sess-1",name:"测试学期",begin_date:fixture.semesterStart,end_date:"2028-01-15"}},data:newData});
    const firstSend=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("queue unavailable"));
    await processScheduleSyncBatch(makeBatch([{subscriptionId:sid,userId:"user-1"}]).batch,testEnv(firstSend));
    const firstState=await db.select().from(notificationState).where(eq(notificationState.userId,"user-1")).get();
    expect(firstState?.pendingNotificationJson).toBeTruthy();
    const pending=JSON.parse(firstState!.pendingNotificationJson!);
    expect(pending.messages.length).toBeGreaterThan(1);
    expect(pending.nextIndex).toBe(1);
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(Date.now()+8*DAY_MS);
    try {
      const retrySend=vi.fn().mockResolvedValue(undefined);
      await processScheduleSyncBatch(makeBatch([{subscriptionId:sid,userId:"user-1"}]).batch,testEnv(retrySend));
      expect(retrySend.mock.calls.map(call=>call[0])).toEqual(pending.messages.slice(pending.nextIndex));
      expect(retrySend.mock.calls.map(call=>call[0].notificationId)).not.toContain(pending.messages[0].notificationId);
      const state=await db.select().from(notificationState).where(eq(notificationState.userId,"user-1")).get();
      expect(state?.pendingNotificationJson).toBeNull();
      expect(state?.snapshotHash).toBe(await hashSchedule(normalizeSchedule(newData)));
    } finally { vi.useRealTimers(); }
  });

  it("issue #98: stops remaining shards when notifications are disabled after the batch is claimed", async () => {
    const sid = await insertSub();
    const fixture = futureCourseFixture();
    const oldData = { semesterStart: fixture.semesterStart, exams: [], courses: Array.from({length:40},(_,index)=>({name:`课程${index}`,lecturer:"张老师",position:"虎溪校区",room:"D123",day_of_week:3,start_session:1,end_session:2,weeks:Array.from({length:18},(_,week)=>week+1)})) };
    const oldSnapshot = normalizeSchedule(oldData);
    await db.insert(notificationState).values({userId:"user-1",enabled:true,snapshotJson:JSON.stringify(oldSnapshot),snapshotHash:await hashSchedule(oldSnapshot),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    const newData={...oldData,courses:oldData.courses.map(item=>({...item,day_of_week:5}))};
    vi.spyOn(harvestModule,"fetchPersonalHarvest").mockResolvedValue({ctx:{sessionId:"sess-1",semesterInfo:{id:"sess-1",name:"测试学期",begin_date:fixture.semesterStart,end_date:"2028-01-15"}},data:newData});
    // Disable lands after the first shard is enqueued but before its progress CAS.
    const send = vi.fn().mockImplementation(async () => {
      if (send.mock.calls.length === 1) {
        await env.DB.prepare("UPDATE notification_state SET enabled = 0 WHERE user_id = 'user-1'").run();
      }
    });

    await processScheduleSyncBatch(makeBatch([{subscriptionId:sid,userId:"user-1"}]).batch,testEnv(send));

    expect(send).toHaveBeenCalledTimes(1);
    const state = await db.select().from(notificationState).where(eq(notificationState.userId,"user-1")).get();
    expect(state?.enabled).toBe(false);
    expect(state?.pendingNotificationJson).toBeTruthy();
  });

  it("keeps the old baseline when notification enqueue fails while the sync still succeeds", async () => {
    const sid = await insertSub();
    const fixture = futureCourseFixture();
    const oldData = { courses: [{ name: "高等数学", lecturer: "张老师", room: "A101", position: "A101", day_of_week: fixture.dayOfWeek, start_session: 1, end_session: 2, weeks: [1] }], exams: [], semesterStart: fixture.semesterStart };
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

  it("uses one initial message to finish all surviving views in the shared run", async () => {
    const runId = crypto.randomUUID();
    const requestedAt = new Date().toISOString();
    const shared = {
      syncStatus: "queued" as const,
      syncRunId: runId,
      syncTrigger: "initial" as const,
      syncRequestedAt: requestedAt,
    };
    const allSid = await insertSub({ ...shared, sourceType: "personal_all", sourceName: "全部" });
    await insertSub({ ...shared, sourceType: "personal_courses", sourceName: "课程" });
    await insertSub({ ...shared, sourceType: "personal_exams", sourceName: "考试" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch, messages } = makeBatch([{
      subscriptionId: allSid,
      userId: "user-1",
      trigger: "initial",
      runId,
    }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(harvest).toHaveBeenCalledTimes(1);
    expect(messages[0].ack).toHaveBeenCalledOnce();
    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.syncStatus === "success")).toBe(true);
    expect(rows.every((row) => row.syncRunId === runId)).toBe(true);
  });

  it.each(["success", "error"] as const)(
    "acks a duplicate message for a terminal %s run without harvesting",
    async (syncStatus) => {
      const runId = crypto.randomUUID();
      const sid = await insertSub({
        sourceType: "personal_all",
        sourceId: "user-1",
        syncStatus,
        syncRunId: runId,
        syncTrigger: "initial",
        syncRequestedAt: new Date().toISOString(),
      });
      const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");
      const { batch, messages } = makeBatch([{
        subscriptionId: sid,
        userId: "user-1",
        trigger: "initial",
        runId,
      }]);

      await processScheduleSyncBatch(batch, env as unknown as Env);

      expect(messages[0].ack).toHaveBeenCalledOnce();
      expect(messages[0].retry).not.toHaveBeenCalled();
      expect(harvest).not.toHaveBeenCalled();
      const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
      expect(row?.syncStatus).toBe(syncStatus);
    },
  );

  it("does not restore a deleted view while completing the shared run", async () => {
    const runId = crypto.randomUUID();
    const shared = {
      syncStatus: "queued" as const,
      syncRunId: runId,
      syncTrigger: "initial" as const,
      syncRequestedAt: new Date().toISOString(),
    };
    const allSid = await insertSub({ ...shared, sourceType: "personal_all" });
    await insertSub({ ...shared, sourceType: "personal_courses" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch } = makeBatch([{ subscriptionId: allSid, userId: "user-1", trigger: "initial", runId }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.syncStatus === "success")).toBe(true);
  });

  it.each(["TGT_EXPIRED", "SESSION_INACTIVE"])(
    "keeps old calendar data while %s waits in the shared recovery budget",
    async (code) => {
      const requestedAt = new Date(Date.now() - 2 * 60_000).toISOString();
      const runId = crypto.randomUUID();
      const sid = await insertSub({
        sourceType: "personal",
        sourceId: "user-1",
        syncStatus: "queued",
        syncRunId: runId,
        syncRequestedAt: requestedAt,
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
        icsContent: "BEGIN:VCALENDAR\r\nOLD\r\nEND:VCALENDAR\r\n",
        coursesJson: '[{"name":"old-course"}]',
        examsJson: '[{"name":"old-exam"}]',
      });
      vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError(code));
      const { batch, messages } = makeBatch([
        { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" },
      ], code === "TGT_EXPIRED" ? 1 : 2);

      await processScheduleSyncBatch(batch, {
        ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
      });

      expect(messages[0].retry).toHaveBeenCalledWith({
        delaySeconds: 60,
      });
      expect(messages[0].ack).not.toHaveBeenCalled();
      const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
      expect(row).toMatchObject({
        syncStatus: "queued",
        syncErrorCode: code,
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
        icsContent: "BEGIN:VCALENDAR\r\nOLD\r\nEND:VCALENDAR\r\n",
        coursesJson: '[{"name":"old-course"}]',
        examsJson: '[{"name":"old-exam"}]',
        isActive: true,
      });
    },
  );

  it("ends recovery after 30 minutes without erasing the last usable calendar", async () => {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      icsContent: "OLD", coursesJson: "[]", examsJson: "[]",
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest")
      .mockRejectedValue(new HarvestError("SESSION_INACTIVE"));
    const { batch, messages } = makeBatch([
      { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" },
    ], 5);

    await processScheduleSyncBatch(batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });

    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row).toMatchObject({
      syncStatus: "error",
      syncErrorCode: "SESSION_INACTIVE",
      syncErrorMessage: "登录状态暂未恢复，本次同步已结束，请稍后重试",
      icsContent: "OLD",
    });
    expect(row?.syncErrorMessage).not.toContain("自动重试");
    expect(row?.syncErrorMessage).not.toContain("重新绑定");
  });

  it.each([45, 46])("ends session recovery on delivery %i before the queue can discard the run", async (attempts) => {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: new Date(Date.now() - 24 * 60_000).toISOString(), icsContent: "OLD",
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("SESSION_INACTIVE"));
    const { batch, messages } = makeBatch([
      { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" },
    ], attempts);

    await processScheduleSyncBatch(batch, { ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled" });

    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(messages[0].ack).toHaveBeenCalledOnce();
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row).toMatchObject({ syncStatus: "error", syncErrorCode: "SESSION_INACTIVE", icsContent: "OLD" });
  });

  it("does not reset recovery when TGT_EXPIRED becomes SESSION_INACTIVE", async () => {
    const runId = crypto.randomUUID();
    const requestedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: requestedAt, icsContent: "OLD",
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest")
      .mockRejectedValueOnce(new HarvestError("TGT_EXPIRED"))
      .mockRejectedValueOnce(new HarvestError("SESSION_INACTIVE"));
    const body = { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" as const };
    const first = makeBatch([body], 1);
    await processScheduleSyncBatch(first.batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });
    const second = makeBatch([body], 2);
    await processScheduleSyncBatch(second.batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });

    expect(first.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(second.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row).toMatchObject({
      syncStatus: "queued",
      syncRequestedAt: requestedAt,
      syncErrorCode: "SESSION_INACTIVE",
      icsContent: "OLD",
    });
  });

  it("starts session recovery at 60s after eleven capacity deliveries", async () => {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(), icsContent: "OLD",
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest")
      .mockRejectedValueOnce(new HarvestError("TGT_EXPIRED"))
      .mockRejectedValueOnce(new HarvestError("SESSION_INACTIVE"));
    const body = { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" as const };
    const first = makeBatch([body], 12);
    await processScheduleSyncBatch(first.batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });
    const second = makeBatch([body], 13);
    await processScheduleSyncBatch(second.batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });

    expect(first.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(second.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    const row = await env.DB.prepare(
      "SELECT session_recovery_attempts,sync_error_code FROM subscriptions WHERE id=?",
    ).bind(sid).first<{ session_recovery_attempts: number; sync_error_code: string }>();
    expect(row).toEqual({ session_recovery_attempts: 2, sync_error_code: "SESSION_INACTIVE" });
  });

  it("commits fresh calendar data when the same recovery run later succeeds", async () => {
    const runId = crypto.randomUUID();
    const requestedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: requestedAt, icsContent: "OLD", coursesJson: '[{"name":"old"}]',
      examsJson: "[]", lastSyncedAt: "2026-09-01T00:00:00.000Z",
    });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest")
      .mockRejectedValueOnce(new HarvestError("TGT_EXPIRED"))
      .mockResolvedValueOnce({
        ctx: {
          sessionId: "term-new",
          semesterInfo: {
            id: "term-new", name: "2026秋", begin_date: "2026-09-07", end_date: "2027-01-15",
          },
        },
        data: {
          courses: [{
            name: "new-course", lecturer: "teacher", room: "A101", position: "A101",
            day_of_week: 1, start_session: 1, end_session: 2, weeks: [1],
          }],
          exams: [],
          semesterStart: "2026-09-07",
        },
      });
    const body = { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" as const };
    const first = makeBatch([body], 1);
    await processScheduleSyncBatch(first.batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });
    const second = makeBatch([body], 2);
    await processScheduleSyncBatch(second.batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });

    expect(first.messages[0].retry).toHaveBeenCalledOnce();
    expect(second.messages[0].ack).toHaveBeenCalledOnce();
    expect(harvest).toHaveBeenCalledTimes(2);
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row?.syncStatus).toBe("success");
    expect(row?.syncRunId).toBe(runId);
    expect(row?.coursesJson).toContain("new-course");
    expect(row?.coursesJson).not.toContain('"old"');
    expect(row?.icsContent).not.toBe("OLD");
    expect(row?.lastSyncedAt).not.toBe("2026-09-01T00:00:00.000Z");
  });

  it("requires rebind immediately only for NEEDS_REAUTH", async () => {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal", sourceId: "user-1", syncStatus: "queued", syncRunId: runId,
      syncRequestedAt: new Date().toISOString(), icsContent: "OLD",
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("NEEDS_REAUTH"));
    const { batch, messages } = makeBatch([
      { subscriptionId: sid, userId: "user-1", runId, trigger: "manual" },
    ]);

    await processScheduleSyncBatch(batch, {
      ...testEnv(), PERSONAL_SUBSCRIPTION_MODE: "enabled",
    });

    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row).toMatchObject({ syncErrorCode: "NEEDS_REAUTH", icsContent: "OLD" });
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

});

describe("processScheduleSyncBatch — shared batch deadline", () => {
  it("shares ONE absolute harvest deadline across every user of the same batch", async () => {
    const sid1 = await insertSub({ userId: "user-1", sourceId: "user-1" });
    const sid2 = await insertSub({ userId: "user-2", sourceId: "user-2" });
    await env.CACHE.put("caps:user-2", JSON.stringify(FULL_CAPS));
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue({
      ctx: { sessionId: "sess-1", semesterInfo: { id: "sess-1", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" } },
      data: { courses: [], exams: [], semesterStart: "2025-09-01" },
    });

    const { batch, messages } = makeBatch([
      { subscriptionId: sid1, userId: "user-1" },
      { subscriptionId: sid2, userId: "user-2" },
    ]);
    await processScheduleSyncBatch(batch, testEnv());

    expect(harvest).toHaveBeenCalledTimes(2);
    expect(messages.every(message => message.ack.mock.calls.length === 1)).toBe(true);
    const deadlines = harvest.mock.calls.map(call => (call[2] as { deadlineAt?: number } | undefined)?.deadlineAt);
    expect(typeof deadlines[0]).toBe("number");
    expect(deadlines[1]).toBe(deadlines[0]);
    // 13-minute batch budget, created once at batch start.
    expect(deadlines[0]!).toBeGreaterThan(Date.now());
    expect(deadlines[0]!).toBeLessThanOrEqual(Date.now() + 13 * 60_000);
  });
});

describe("processScheduleSyncBatch — capacity wait (BROWSER_BUSY)", () => {
  async function insertQueuedRunSub(overrides: Partial<typeof subscriptions.$inferInsert> = {}) {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      syncStatus: "queued",
      syncRunId: runId,
      syncRequestedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      ...overrides,
    });
    return { sid, runId };
  }

  it("retries BROWSER_BUSY with a bounded 60-90s delay, shows 排队中, and touches no data", async () => {
    const { sid, runId } = await insertQueuedRunSub({
      lastSyncedAt: "2026-09-01T00:00:00.000Z",
      coursesJson: "[{\"name\":\"高等数学\"}]",
    });
    const send = vi.fn();
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("BROWSER_BUSY"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", runId }], 2);
    await processScheduleSyncBatch(batch, testEnv(send));

    expect(messages[0].retry).toHaveBeenCalledOnce();
    const { delaySeconds } = messages[0].retry.mock.calls[0][0] as { delaySeconds: number };
    expect(delaySeconds).toBeGreaterThanOrEqual(60);
    expect(delaySeconds).toBeLessThanOrEqual(90);
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row?.syncStatus).toBe("queued");
    expect(row?.syncErrorCode).toBe("BROWSER_BUSY");
    expect(row?.syncErrorMessage).toBe("同步任务排队中，稍后自动重试");
    expect(row?.lastSyncedAt).toBe("2026-09-01T00:00:00.000Z"); // untouched
    expect(row?.coursesJson).toBe("[{\"name\":\"高等数学\"}]"); // untouched
  });

  it("fails the run (ack, no retry) once the capacity wait exceeds 45 minutes, keeping old data", async () => {
    const { sid, runId } = await insertQueuedRunSub({
      syncRequestedAt: new Date(Date.now() - 46 * 60_000).toISOString(),
      lastSyncedAt: "2026-09-01T00:00:00.000Z",
      coursesJson: "[{\"name\":\"高等数学\"}]",
    });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("BROWSER_BUSY"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", runId }], 10);
    await processScheduleSyncBatch(batch, testEnv());

    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();

    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row?.syncStatus).toBe("error");
    expect(row?.syncErrorCode).toBe("BROWSER_BUSY");
    expect(row?.syncErrorMessage).not.toContain("排队"); // terminal: no queueing text
    expect(row?.lastSyncedAt).toBe("2026-09-01T00:00:00.000Z"); // preserved
    expect(row?.coursesJson).toBe("[{\"name\":\"高等数学\"}]"); // preserved
  });

  it("still waits on the 44th attempt but fails the run on the 45th", async () => {
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(
      new HarvestError("BROWSER_BUSY"),
    );

    const run44 = await insertQueuedRunSub({
      syncRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const first = makeBatch(
      [{ subscriptionId: run44.sid, userId: "user-1", runId: run44.runId }],
      44,
    );
    await processScheduleSyncBatch(first.batch, testEnv());
    expect(first.messages[0].retry).toHaveBeenCalledOnce();
    const { delaySeconds } = first.messages[0].retry.mock.calls[0][0] as { delaySeconds: number };
    expect(delaySeconds).toBeGreaterThanOrEqual(60);
    expect(delaySeconds).toBeLessThanOrEqual(90);
    expect(first.messages[0].ack).not.toHaveBeenCalled();

    const run45 = await insertQueuedRunSub({
      syncRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const second = makeBatch(
      [{ subscriptionId: run45.sid, userId: "user-1", runId: run45.runId }],
      45,
    );
    await processScheduleSyncBatch(second.batch, testEnv());
    expect(second.messages[0].retry).not.toHaveBeenCalled();
    expect(second.messages[0].ack).toHaveBeenCalledOnce();
    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, run45.sid)).get();
    expect(row?.syncStatus).toBe("error");
    expect(row?.syncErrorCode).toBe("BROWSER_BUSY");
    expect(row?.syncErrorMessage).not.toContain("排队");
  });

  it("falls back to the original finite retry when the run has no syncRequestedAt", async () => {
    const { sid, runId } = await insertQueuedRunSub({ syncRequestedAt: null });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("BROWSER_BUSY"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", runId }], 1);
    await processScheduleSyncBatch(batch, testEnv());

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("falls back to the original finite retry when syncRequestedAt is unparseable", async () => {
    const { sid, runId } = await insertQueuedRunSub({ syncRequestedAt: "not-a-date" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("BROWSER_BUSY"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", runId }], 1);
    await processScheduleSyncBatch(batch, testEnv());

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("acks a stale message without touching the newer run or harvesting", async () => {
    const sid = await insertSub({
      syncStatus: "running",
      syncRunId: "newer-run",
      syncRequestedAt: new Date().toISOString(),
      sessionRecoveryAttempts: 4,
    });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", runId: "older-run" }]);
    await processScheduleSyncBatch(batch, testEnv());

    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();

    const row = await db.select().from(subscriptions).where(eq(subscriptions.id, sid)).get();
    expect(row?.syncStatus).toBe("running");
    expect(row?.syncRunId).toBe("newer-run");
    expect(row?.sessionRecoveryAttempts).toBe(4);
  });
});
