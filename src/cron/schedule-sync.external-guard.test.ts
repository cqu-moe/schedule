import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { subscriptions } from "../db/schema";

// Legacy external subscriptions must never reach the personal-harvest path. Force
// EXTERNAL_DISABLED=false so an incorrect legacy fallback reaches personal harvest
// and can overwrite an external public link with the owner's own data.
vi.mock("../config/external-availability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/external-availability")>();
  return { ...actual, EXTERNAL_DISABLED: false };
});

const { processScheduleSyncBatch, enqueueScheduleSync } = await import("./schedule-sync");
type ScheduleSyncMessage = import("./schedule-sync").ScheduleSyncMessage;
const harvestModule = await import("../services/cqu-harvest");
import type { Env } from "../types";

const db = drizzle(env.DB);

const FULL_CAPS = {
  sync: true, external: true, share: true,
  sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
};

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_setup").run();
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();
  await env.DB.prepare(
    `CREATE TABLE subscriptions (
      source_course_id text, source_course_name text, reselection_requested_at text,
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
  await env.DB.prepare(
    `CREATE TABLE calendar_links (
      id text PRIMARY KEY NOT NULL,
      subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE, label text, formats text NOT NULL,
      personal_view_type text,
      is_default integer NOT NULL DEFAULT 0,
      is_active integer NOT NULL DEFAULT 1,
      created_at text NOT NULL, updated_at text NOT NULL
    )`,
  ).run();
  await env.DB.prepare(`CREATE TABLE personal_subscription_setup (
    user_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created','existing')),
    subscription_ids TEXT NOT NULL DEFAULT '[]', run_id TEXT,
    dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending','sending','sent','failed')),
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_subscription_setup").run();
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM subscriptions").run();
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

function makeBatch(bodies: ScheduleSyncMessage[]) {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  return { batch: { queue: "schedule-sync", messages } as unknown as MessageBatch<ScheduleSyncMessage>, messages };
}

describe("external automatic scheduling boundaries (EXTERNAL_DISABLED=false)", () => {
  it("consumer: a legacy external sub is ack-skipped and never personal-harvested", async () => {
    // Pre-set lastSyncedAt to a known value to prove it is NOT overwritten by a
    // bogus personal harvest of the owner's data onto an external public link.
    const frozenAt = "2024-01-01T00:00:00.000Z";
    const sid = await insertSub({
      sourceType: "instructor",
      sourceId: "T-42",
      isPersonal: false,
      lastSyncedAt: frozenAt,
      coursesJson: "[]",
    });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    // Acked (permanent skip), never retried, and NO personal harvest attempted.
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();

    // Data untouched: lastSyncedAt unchanged — the external public link was NOT
    // overwritten with the owner's personal schedule.
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBe(frozenAt);
  });

  it("producer: a due legacy external sub is not enqueued, but is_active revocation still reconciles", async () => {
    // Owner LOST the `external` cap; with EXTERNAL_DISABLED=false the producer must
    // STILL reconcile is_active→false (revocation enforced) yet NOT enqueue the
    // legacy sub has no new capture path. A due personal sub still enqueues.
    const personalSid = await insertSub({
      userId: "user-ext",
      sourceType: "personal_all",
      sourceId: "user-ext",
      lastSyncedAt: null,
    });
    const extSid = await insertSub({
      userId: "user-ext",
      sourceType: "instructor",
      sourceId: "T-99",
      isPersonal: false,
      isActive: true,
      lastSyncedAt: null,
    });
    await env.CACHE.put(
      "caps:user-ext",
      JSON.stringify({
        sync: true, external: false, share: true,
        sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
      }),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-ext");

    // Revocation reconcile ran even with the flag off: external link cut.
    const [extRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, extSid));
    expect(extRow.isActive).toBe(false);

    // Only the personal sub was enqueued; the legacy external sub was NOT.
    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    const ids = batch.map((m) => m.body.subscriptionId);
    expect(ids).toContain(personalSid);
    expect(ids).not.toContain(extSid);
  });

  it("producer: a due legacy external sub whose owner is still entitled is not enqueued", async () => {
    // The owner still has `external`, so only the frozen source_version=0 guard
    // can keep this row out of the automatic path. With EXTERNAL_DISABLED=false,
    // an incorrect fallback would let it reach the personal harvest.
    await insertSub({
      userId: "user-ext2",
      sourceType: "instructor",
      sourceId: "T-77",
      isPersonal: false,
      isActive: true,
      lastSyncedAt: null,
    });
    await env.CACHE.put("caps:user-ext2", JSON.stringify(FULL_CAPS)); // external GRANTED
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-ext2");

    // Entitled legacy external sub is not enqueued.
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("producer: new external rows use only their independent automatic interval", async () => {
    const oldEnough = new Date(Date.now() - 16 * 60_000).toISOString();
    await insertSub({
      id: "external-v1-due",
      userId: "user-external-interval",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-due",
      isPersonal: false,
      lastSyncedAt: oldEnough,
    });
    await insertSub({
      userId: "user-external-interval",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-too-recent",
      isPersonal: false,
      lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    await insertSub({
      userId: "user-external-missing",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-missing",
      isPersonal: false,
      lastSyncedAt: oldEnough,
    });
    await insertSub({
      userId: "user-external-zero",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-zero",
      isPersonal: false,
      lastSyncedAt: oldEnough,
    });
    await insertSub({
      userId: "user-external-personal-only",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-personal-only",
      isPersonal: false,
      lastSyncedAt: oldEnough,
    });
    await insertSub({
      userId: "user-external-legacy",
      sourceType: "admin_class",
      sourceVersion: 0,
      sourceId: "admin-legacy",
      isPersonal: false,
      lastSyncedAt: oldEnough,
    });

    await env.CACHE.put("caps:user-external-interval", JSON.stringify({ ...FULL_CAPS, external_sync_interval: 15 }));
    await env.CACHE.put("caps:user-external-missing", JSON.stringify(FULL_CAPS));
    await env.CACHE.put("caps:user-external-zero", JSON.stringify({ ...FULL_CAPS, external_sync_interval: 0 }));
    await env.CACHE.put("caps:user-external-personal-only", JSON.stringify({ ...FULL_CAPS, sync_interval: 15 }));
    await env.CACHE.put("caps:user-external-legacy", JSON.stringify({ ...FULL_CAPS, external_sync_interval: 15 }));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    for (const user of [
      "user-external-interval",
      "user-external-missing",
      "user-external-zero",
      "user-external-personal-only",
      "user-external-legacy",
    ]) await env.CACHE.delete(`caps:${user}`);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch.map((message) => message.body.subscriptionId)).toEqual(["external-v1-due"]);
    expect(batch[0].body).toMatchObject({
      sourceVersion: 1,
      targetRevision: 0,
      trigger: "cron",
      runId: expect.any(String),
    });
  });

  it("producer: terminal user-action failures stop, while transient failures keep bounded retry", async () => {
    const oldEnough = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await insertSub({
      id: "external-v1-transient",
      userId: "user-external-retry",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-transient",
      isPersonal: false,
      lastSyncedAt: oldEnough,
      syncStatus: "error",
      syncErrorCode: "EXTERNAL_SYNC_UNAVAILABLE",
      syncRequestedAt: oldEnough,
    });
    await insertSub({
      userId: "user-external-retry",
      sourceType: "admin_class",
      sourceVersion: 1,
      sourceId: "admin-reauth",
      isPersonal: false,
      lastSyncedAt: oldEnough,
      syncStatus: "error",
      syncErrorCode: "NEEDS_REAUTH",
      syncRequestedAt: oldEnough,
    });
    await env.CACHE.put("caps:user-external-retry", JSON.stringify({ ...FULL_CAPS, external_sync_interval: 15 }));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-external-retry");

    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch.map((message) => message.body.subscriptionId)).toEqual(["external-v1-transient"]);
  });

  it("does not queue an obsolete due snapshot after a concurrent cron run already finished", async () => {
    const sid = await insertSub({ userId: "user-stale-snapshot", sourceType: "admin_class", sourceVersion: 1,
      sourceId: "class-stale-snapshot", isPersonal: false, lastSyncedAt: "2000-01-01T00:00:00.000Z", syncRunId: "old-run" });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, AUTH: { getCaps: async () => {
      // Cap resolution occurs after the producer reads its due snapshot. A
      // second producer and consumer finish before this invocation can claim.
      await db.update(subscriptions).set({ syncRunId: "concurrent-finished-run", syncStatus: "success", lastSyncedAt: new Date().toISOString() })
        .where(eq(subscriptions.id, sid));
      return { calendar: { ...FULL_CAPS, external_sync_interval: 15 } };
    } }, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;
    await enqueueScheduleSync(testEnv);
    expect(sendBatch).not.toHaveBeenCalled();
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.syncRunId).toBe("concurrent-finished-run");
  });

  it("producer: external cron messages are staggered by stable user and subscription ids", async () => {
    const oldEnough = new Date(Date.now() - 16 * 60_000).toISOString();
    await insertSub({ id: "late-user-sub", userId: "user-z-late", sourceType: "admin_class", sourceVersion: 1, sourceId: "late", isPersonal: false, lastSyncedAt: oldEnough });
    await insertSub({ id: "stable-z", userId: "user-stable", sourceType: "admin_class", sourceVersion: 1, sourceId: "stable-z", isPersonal: false, lastSyncedAt: oldEnough });
    await insertSub({ id: "stable-a", userId: "user-stable", sourceType: "admin_class", sourceVersion: 1, sourceId: "stable-a", isPersonal: false, lastSyncedAt: oldEnough });
    await env.CACHE.put("caps:user-z-late", JSON.stringify({ ...FULL_CAPS, external_sync_interval: 15 }));
    await env.CACHE.put("caps:user-stable", JSON.stringify({ ...FULL_CAPS, external_sync_interval: 15 }));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-z-late");
    await env.CACHE.delete("caps:user-stable");

    const batch = sendBatch.mock.calls[0][0] as Array<{ body: ScheduleSyncMessage; delaySeconds: number }>;
    expect(batch.map((message) => message.body.subscriptionId))
      .toEqual(["stable-a", "stable-z", "late-user-sub"]);
    expect(batch.map((message) => message.delaySeconds)).toEqual([0, 300, 600]);
  });
});
