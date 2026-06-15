import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { subscriptions } from "../db/schema";
import {
  enqueueScheduleSync,
  processScheduleSyncBatch,
  type ScheduleSyncMessage,
} from "./schedule-sync";
import * as bearerModule from "../services/cqu-bearer";
import { CQUAPIClient } from "../services/cqu-api";
import type { Env } from "../types";

const db = drizzle(env.DB);

/** Build a fake CQU bearer JWT carrying the given `user_name` (学号) claim. */
function fakeBearer(userName: string): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url({ user_name: userName })}.sig`;
}

// ── DB setup (real D1 from cloudflare:test) ──────────────────────────────────

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();
  await env.DB.prepare(
    `CREATE TABLE subscriptions (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      source_type text NOT NULL,
      source_id text NOT NULL,
      source_name text NOT NULL,
      session_id text,
      session_name text,
      semester_start text,
      is_personal integer NOT NULL DEFAULT 0,
      ics_content text,
      courses_json text,
      exams_json text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`,
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM subscriptions").run();
  // Clear any cached student IDs so each test resolves from its own bearer.
  await env.CACHE.delete("student:user-1");
  await env.CACHE.delete("student:user-attacker");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Insert a subscription fixture directly into D1. */
async function insertSub(
  overrides: Partial<typeof subscriptions.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(subscriptions).values({
    id,
    userId: "user-1",
    sourceType: "personal_all",
    sourceId: "20210001",
    sourceName: "我的课表",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

// ════════════════════════════════════════════════════════════════════════════
//  Producer: enqueueScheduleSync (due-subscription selection by sync_interval)
// ════════════════════════════════════════════════════════════════════════════

describe("enqueueScheduleSync (producer)", () => {
  it("does not call sendBatch when there are no subscriptions", async () => {
    const sendBatch = vi.fn();
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;
    await enqueueScheduleSync(testEnv);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("enqueues never-synced subscriptions (lastSyncedAt null)", async () => {
    const sid = await insertSub({ lastSyncedAt: null });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch).toHaveLength(1);
    // Cron-produced messages carry trigger:"cron" so the consumer can re-check
    // due-ness and drop the duplicates that the hourly+spread producer enqueues.
    expect(batch[0].body).toEqual({ subscriptionId: sid, userId: "user-1", trigger: "cron" });
  });

  it("skips subscriptions synced within the default interval (1440 min)", async () => {
    // Synced 1 hour ago; default interval is 24h → not due.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await insertSub({ lastSyncedAt: recent });

    const sendBatch = vi.fn();
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("enqueues subscriptions past the default interval", async () => {
    // Synced 2 days ago → past default 24h interval → due.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ lastSyncedAt: old });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch.map((m) => m.body.subscriptionId)).toContain(sid);
  });

  it("uses the per-user sync_interval from caps KV (short interval → due)", async () => {
    // Synced 2 hours ago. With a 60-min cap interval this is due.
    const synced = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ userId: "user-fast", lastSyncedAt: synced });
    await env.CACHE.put(
      "caps:user-fast",
      JSON.stringify({ sync_interval: 60 }),
    );

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-fast");

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch.map((m) => m.body.subscriptionId)).toContain(sid);
  });

  it("refreshes caps via AUTH.getCaps on a KV miss (honors a short interval offline)", async () => {
    // Synced 2h ago with NO caps:<user> in KV (1h session TTL expired). Without
    // a refresh the producer would fall back to the 24h default and skip; with
    // getCaps it sees the 60-min interval and enqueues.
    const synced = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ userId: "user-cap-miss", lastSyncedAt: synced });
    await env.CACHE.delete("caps:user-cap-miss");

    const getCaps = vi.fn().mockResolvedValue({
      calendar: {
        sync: true, external: true, share: true,
        sub_limit: 10, share_limit: 20, sync_interval: 60, manual_refresh: 20,
      },
    });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      SCHEDULE_SYNC_QUEUE: { sendBatch },
      AUTH: { getCaps },
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-cap-miss");

    expect(getCaps).toHaveBeenCalledWith("user-cap-miss");
    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch.map((m) => m.body.subscriptionId)).toContain(sid);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Consumer: processScheduleSyncBatch
// ════════════════════════════════════════════════════════════════════════════

/** Build a fake MessageBatch over the given messages with ack/retry spies. */
function makeBatch(bodies: ScheduleSyncMessage[]) {
  const messages = bodies.map((body) => ({
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return { batch: { queue: "schedule-sync", messages } as unknown as MessageBatch<ScheduleSyncMessage>, messages };
}

describe("processScheduleSyncBatch (consumer)", () => {
  it("syncs a personal subscription using the bearer's own 学号, not the stored sourceId", async () => {
    // The stored sourceId is the trusted auth user.id (NOT a 学号). The personal
    // schedule must be fetched against the bearer subject's own 学号.
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    await env.CACHE.delete("sync:personal:20210001");

    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue(fakeBearer("20210001"));
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-1",
      sessions: {},
    });
    vi.spyOn(CQUAPIClient.prototype, "getSemesterInfo").mockResolvedValue({
      id: "sess-1",
      name: "2024秋",
      begin_date: "2024-09-01",
      end_date: "2025-01-15",
    });
    const getSchedule = vi
      .spyOn(CQUAPIClient.prototype, "getSchedule")
      .mockResolvedValue([]);
    vi.spyOn(CQUAPIClient.prototype, "getExams").mockResolvedValue([]);

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    // Fetched the bearer's own 学号 (20210001), not the stored sourceId (user-1).
    expect(getSchedule).toHaveBeenCalledWith("20210001", "sess-1");

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.coursesJson).toBe("[]");
    expect(row.icsContent).toContain("BEGIN:VCALENDAR");
  });

  it("SECURITY: ignores a crafted/other-student sourceId; fetches only the bearer subject's schedule", async () => {
    // An attacker stored another student's 学号 (20219999) as sourceId hoping the
    // sync would leak that student's private schedule via the public link. The
    // sync must instead resolve the bearer's OWN 学号 (20210001) and never touch
    // the stored sourceId.
    const sid = await insertSub({
      sourceType: "personal_all",
      sourceId: "20219999", // forged: someone else's 学号
    });
    await env.CACHE.delete("sync:personal:20210001");
    await env.CACHE.delete("sync:personal:20219999");

    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue(fakeBearer("20210001"));
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-1",
      sessions: {},
    });
    vi.spyOn(CQUAPIClient.prototype, "getSemesterInfo").mockResolvedValue({
      id: "sess-1",
      name: "2024秋",
      begin_date: "2024-09-01",
      end_date: "2025-01-15",
    });
    const getSchedule = vi
      .spyOn(CQUAPIClient.prototype, "getSchedule")
      .mockResolvedValue([]);
    vi.spyOn(CQUAPIClient.prototype, "getExams").mockResolvedValue([]);

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    // Only the bearer's own 学号 was queried — the forged sourceId was ignored.
    expect(getSchedule).toHaveBeenCalledWith("20210001", "sess-1");
    expect(getSchedule).not.toHaveBeenCalledWith("20219999", "sess-1");
  });

  it("skips and acks (no retry) a personal sub when the bearer has no 学号", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    // Opaque (non-JWT) bearer → no resolvable 学号.
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("opaque-bearer");
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-1",
      sessions: {},
    });
    vi.spyOn(CQUAPIClient.prototype, "getSemesterInfo").mockResolvedValue({
      id: "sess-1",
      name: "2024秋",
      begin_date: "2024-09-01",
      end_date: "2025-01-15",
    });
    const getSchedule = vi.spyOn(CQUAPIClient.prototype, "getSchedule");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(getSchedule).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull();
  });

  it("syncs an external subscription via fetchTargetSchedule", async () => {
    const sid = await insertSub({
      sourceType: "instructor",
      sourceId: "T-42",
      isPersonal: false,
    });

    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-1",
      sessions: {},
    });
    vi.spyOn(CQUAPIClient.prototype, "getSemesterInfo").mockResolvedValue({
      id: "sess-1",
      name: "2024秋",
      begin_date: "2024-09-01",
      end_date: "2025-01-15",
    });
    const fetchTarget = vi
      .spyOn(CQUAPIClient.prototype, "fetchTargetSchedule")
      .mockResolvedValue([]);

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(fetchTarget).toHaveBeenCalledWith("instructor", "T-42", "sess-1");
    expect(messages[0].ack).toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBeNull();
  });

  it("external sub with an explicit non-current session syncs THAT session and keeps it", async () => {
    // Created for a past semester (sess-old), not the current one (sess-1). The
    // consumer must fetch sess-old's schedule and preserve sess-old on the row,
    // not silently switch the subscription to the current semester.
    await env.CACHE.delete("session:current");
    const sid = await insertSub({
      sourceType: "instructor",
      sourceId: "T-42",
      isPersonal: false,
      sessionId: "sess-old",
      sessionName: "2023春",
    });

    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-1",
      sessions: {},
    });
    vi.spyOn(CQUAPIClient.prototype, "getSemesterInfo").mockImplementation(
      async (id: string) => ({
        id,
        name: id === "sess-old" ? "2023春" : "2024秋",
        begin_date: id === "sess-old" ? "2023-02-20" : "2024-09-01",
        end_date: id === "sess-old" ? "2023-07-01" : "2025-01-15",
      }),
    );
    const fetchTarget = vi
      .spyOn(CQUAPIClient.prototype, "fetchTargetSchedule")
      .mockResolvedValue([]);

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    // Fetched the requested session, NOT the current one.
    expect(fetchTarget).toHaveBeenCalledWith("instructor", "T-42", "sess-old");

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.sessionId).toBe("sess-old"); // preserved, not overwritten to sess-1
  });

  it("skips and acks (does not retry) when getCquBearer returns null", async () => {
    const sid = await insertSub();
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue(null);
    const getScheduleSpy = vi.spyOn(CQUAPIClient.prototype, "getSchedule");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(getScheduleSpy).not.toHaveBeenCalled();

    // Row untouched: never synced.
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull();
  });

  it("acks (no retry) when the subscription no longer exists", async () => {
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const { batch, messages } = makeBatch([
      { subscriptionId: "gone", userId: "user-1" },
    ]);
    await processScheduleSyncBatch(batch, env as unknown as Env);
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
  });

  it("retries when the CQU fetch throws", async () => {
    const sid = await insertSub();
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockRejectedValue(
      new Error("upstream 500"),
    );

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].retry).toHaveBeenCalled();
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  // ── Cron idempotency guard (duplicate-enqueue protection) ──────────────────
  //  The hourly producer spreads each due batch over 6h, so intervening cron
  //  runs re-enqueue subscriptions whose delayed message has not executed. The
  //  consumer re-checks due-ness for cron messages so duplicates no-op; manual
  //  refreshes bypass the check and always sync.

  it("cron message: skips and acks a subscription that is not yet due (no resync)", async () => {
    // Synced 1h ago; default interval is 24h → not due. A cron duplicate must
    // no-op rather than re-fetch upstream.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ lastSyncedAt: recent });
    const getBearer = vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const getSchedule = vi.spyOn(CQUAPIClient.prototype, "getSchedule");

    const { batch, messages } = makeBatch([
      { subscriptionId: sid, userId: "user-1", trigger: "cron" },
    ]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    // Re-check happens before any upstream work — bearer is never even fetched.
    expect(getBearer).not.toHaveBeenCalled();
    expect(getSchedule).not.toHaveBeenCalled();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBe(recent); // untouched
  });

  it("manual message: syncs even when the subscription is not yet due", async () => {
    // Same not-due row, but a manual refresh must always run.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1", lastSyncedAt: recent });
    await env.CACHE.delete("sync:personal:20210001");

    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue(fakeBearer("20210001"));
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-1",
      sessions: {},
    });
    vi.spyOn(CQUAPIClient.prototype, "getSemesterInfo").mockResolvedValue({
      id: "sess-1",
      name: "2024秋",
      begin_date: "2024-09-01",
      end_date: "2025-01-15",
    });
    const getSchedule = vi.spyOn(CQUAPIClient.prototype, "getSchedule").mockResolvedValue([]);
    vi.spyOn(CQUAPIClient.prototype, "getExams").mockResolvedValue([]);

    const { batch, messages } = makeBatch([
      { subscriptionId: sid, userId: "user-1", trigger: "manual" },
    ]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(getSchedule).toHaveBeenCalledWith("20210001", "sess-1");

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBe(recent); // re-synced
  });
});
