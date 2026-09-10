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
import * as harvestModule from "../services/cqu-harvest";
import { HarvestError } from "../services/cqu-harvest";
import * as syncModule from "../services/sync";
import type { Env } from "../types";

const db = drizzle(env.DB);

// ── DB setup (real D1 from cloudflare:test) ──────────────────────────────────

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_setup").run();
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
      is_active integer NOT NULL DEFAULT 1,
      ics_content text,
      courses_json text,
      exams_json text,
      last_synced_at text,
      sync_status text NOT NULL DEFAULT 'idle', sync_run_id text, sync_trigger text,
      sync_requested_at text, sync_started_at text, sync_finished_at text,
      sync_error_code text, sync_error_message text,
      manual_refresh_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
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
  await env.DB.prepare(`CREATE TABLE personal_subscription_setup (
    user_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created','existing')),
    subscription_ids TEXT NOT NULL DEFAULT '[]', run_id TEXT,
    dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending','sending','sent','failed')),
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
});

/** Full calendar caps (everything granted) for the default test user. */
const FULL_CAPS = {
  sync: true, external: true, share: true,
  change_notification: false,
  sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_subscription_setup").run();
  await env.DB.prepare("DELETE FROM subscriptions").run();
  await env.DB.prepare("DELETE FROM notification_state").run();
  // Clear any cached student IDs so each test resolves from its own bearer.
  await env.CACHE.delete("student:user-1");
  await env.CACHE.delete("student:user-attacker");
  // Entitlement now fails closed on missing caps, so give the default user-1 a
  // full caps entry. Tests for revocation/cap-miss use their own user ids/caps.
  await env.CACHE.put("caps:user-1", JSON.stringify(FULL_CAPS));
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
  it("recovers one pending personal setup message before selecting cron work", async () => {
    const runId = crypto.randomUUID();
    const sid = await insertSub({
      sourceType: "personal_all",
      sourceId: "user-1",
      syncStatus: "queued",
      syncRunId: runId,
      syncTrigger: "initial",
      syncRequestedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO personal_subscription_setup
      (user_id,status,subscription_ids,run_id,dispatch_status,created_at,updated_at)
      VALUES (?,'created',?,?,'pending',?,?)`)
      .bind("user-1", JSON.stringify([sid]), runId, now, now)
      .run();
    const send = vi.fn(async () => undefined);
    const sendBatch = vi.fn(async () => undefined);

    await enqueueScheduleSync({
      ...env,
      SCHEDULE_SYNC_QUEUE: { send, sendBatch },
    } as unknown as Env);

    expect(send).toHaveBeenCalledWith({
      subscriptionId: sid,
      userId: "user-1",
      trigger: "initial",
      runId,
    });
    expect(sendBatch).not.toHaveBeenCalled();
  });

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
    expect(batch[0].body).toEqual({
      subscriptionId: sid,
      userId: "user-1",
      trigger: "cron",
      runId: expect.any(String),
    });
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

  it("does not supersede an active queued sync on the next hourly cron", async () => {
    await insertSub({
      lastSyncedAt: null,
      syncStatus: "queued",
      syncRunId: "existing-run",
      syncRequestedAt: new Date().toISOString(),
    });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
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
      JSON.stringify({
        sync: true, external: true, share: true,
        sub_limit: 10, share_limit: 20, sync_interval: 60, manual_refresh: 20,
      }),
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
      CALENDAR_CLIENT_ID: "test-client-id",
      CALENDAR_CLIENT_SECRET: "test-secret",
    } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-cap-miss");

    // getCaps is authenticated like getCquTicket — must pass {clientId, clientSecret, userId}.
    expect(getCaps).toHaveBeenCalledWith({
      clientId: "test-client-id",
      clientSecret: "test-secret",
      userId: "user-cap-miss",
    });
    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    expect(batch.map((m) => m.body.subscriptionId)).toContain(sid);
  });

  it("reconciles is_active → false when the cap is revoked", async () => {
    const sid = await insertSub({ userId: "user-rev2", isActive: true, lastSyncedAt: null });
    await env.CACHE.put(
      "caps:user-rev2",
      JSON.stringify({
        sync: false, external: false, share: false,
        sub_limit: 0, share_limit: 0, sync_interval: 1440, manual_refresh: 0,
      }),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await enqueueScheduleSync({ ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env);
    await env.CACHE.delete("caps:user-rev2");

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(false);
  });

  it("reconciles is_active → true when the cap is restored", async () => {
    const sid = await insertSub({
      userId: "user-grant",
      isActive: false,
      lastSyncedAt: new Date().toISOString(),
    });
    await env.CACHE.put(
      "caps:user-grant",
      JSON.stringify({
        sync: true, external: true, share: true,
        sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
      }),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await enqueueScheduleSync({ ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env);
    await env.CACHE.delete("caps:user-grant");

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(true);
  });

  it("fails closed: does NOT enqueue when caps are unresolvable (null)", async () => {
    // No caps KV and the test AUTH stub has no getCaps → readCaps returns null →
    // entitlement fails closed → due sub is not enqueued.
    await insertSub({ userId: "user-nocaps", lastSyncedAt: null });
    await env.CACHE.delete("caps:user-nocaps");
    const sendBatch = vi.fn().mockResolvedValue(undefined);

    await enqueueScheduleSync({ ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("does NOT enqueue external subs (no external sync path; no endless no-op churn)", async () => {
    // A due external sub has no harvest path (Option A): the consumer ack-skips it
    // without touching lastSyncedAt, so without producer-side filtering it would
    // be re-selected every hourly cron forever. The producer must exclude external
    // sourceTypes UNCONDITIONALLY so they are never enqueued. A due personal sub for
    // the same user must still be enqueued.
    const personalSid = await insertSub({ sourceType: "personal_all", sourceId: "user-1", lastSyncedAt: null });
    await insertSub({ sourceType: "instructor", sourceId: "T-42", isPersonal: false, lastSyncedAt: null });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    const ids = batch.map((m) => m.body.subscriptionId);
    expect(ids).toContain(personalSid); // personal still enqueued
    expect(ids).toHaveLength(1); // external NOT enqueued
  });

  it("reconciles a frozen external sub to is_active=false on cap revocation, AND does not enqueue it", async () => {
    // An owner LOSES the `external` cap (revocation) on an external sub that has no
    // sync path (Option A). The producer must STILL run the is_active reconciliation
    // for that sub — so the revoked external sub flips inactive and its public link
    // stops serving — yet it must NOT be enqueued (external is never enqueued). The
    // external skip therefore has to run AFTER the caps/is_active reconciliation.
    const extSid = await insertSub({
      userId: "user-ext-rev",
      sourceType: "instructor",
      sourceId: "T-99",
      isPersonal: false,
      isActive: true,
      lastSyncedAt: null,
    });
    await env.CACHE.put(
      "caps:user-ext-rev",
      JSON.stringify({
        sync: true, external: false, share: true,
        sub_limit: 10, share_limit: 20, sync_interval: 1440, manual_refresh: 20,
      }),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-ext-rev");

    // Revocation enforced even while frozen: link stops serving.
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, extSid));
    expect(row.isActive).toBe(false);
    // Still not enqueued (external frozen).
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("does NOT enqueue a personal sub when the sync cap is revoked (caps.sync=false)", async () => {
    await insertSub({ userId: "user-revoked", lastSyncedAt: null }); // due, but downgraded
    await env.CACHE.put(
      "caps:user-revoked",
      JSON.stringify({
        sync: false, external: false, share: false,
        sub_limit: 0, share_limit: 0, sync_interval: 1440, manual_refresh: 0,
      }),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = { ...env, SCHEDULE_SYNC_QUEUE: { sendBatch } } as unknown as Env;

    await enqueueScheduleSync(testEnv);
    await env.CACHE.delete("caps:user-revoked");

    expect(sendBatch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Consumer: processScheduleSyncBatch
// ════════════════════════════════════════════════════════════════════════════

/** Build a fake MessageBatch over the given messages with ack/retry spies. */
function makeBatch(bodies: ScheduleSyncMessage[], attempts = 1) {
  const messages = bodies.map((body) => ({
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return { batch: { queue: "schedule-sync", messages } as unknown as MessageBatch<ScheduleSyncMessage>, messages };
}


describe("processScheduleSyncBatch (consumer)", () => {
  /** Default happy-path harvest result for a personal sub. */
  function okHarvest() {
    return {
      ctx: {
        sessionId: "sess-1",
        semesterInfo: { id: "sess-1", name: "2024秋", begin_date: "2024-09-01", end_date: "2025-01-15" },
      },
      data: { courses: [], exams: [], semesterStart: "2024-09-01" },
    };
  }

  it("syncs a personal subscription via harvest (no bearer, no stored sourceId)", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue(okHarvest());

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    // Harvest is keyed by the auth userId only — the stored sourceId is never used.
    expect(harvest).toHaveBeenCalledWith(expect.anything(), "user-1", { deadlineAt: expect.any(Number) });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.coursesJson).toBe("[]");
    expect(row.icsContent).toContain("BEGIN:VCALENDAR");
  });

  it("keeps a completed sync successful when notification processing fails", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue(okHarvest());
    await env.DB.prepare("DROP TABLE notification_state").run();

    try {
      const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
      await processScheduleSyncBatch(batch, env as unknown as Env);

      expect(messages[0].ack).toHaveBeenCalled();
      expect(messages[0].retry).not.toHaveBeenCalled();
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
      expect(row.lastSyncedAt).not.toBeNull();
      expect(row.syncStatus).toBe("success");
    } finally {
      await env.DB.prepare(
        `CREATE TABLE notification_state (
          user_id text PRIMARY KEY NOT NULL, enabled integer NOT NULL DEFAULT 0,
          snapshot_json text, snapshot_hash text,
          created_at text NOT NULL, updated_at text NOT NULL
        )`,
      ).run();
    }
  });

  it("ICS UID namespace is the per-user sourceId, not the shared semester id (no cross-user UID collision)", async () => {
    // Two DIFFERENT users syncing the SAME semester (same ctx.semesterInfo.id).
    // The UID namespace must be per-user (sub.sourceId, pinned to user.id for
    // personal subs) — using the term/semester id "sess-1" would be identical for
    // every user and collide UIDs across shared calendars.
    await env.CACHE.put("caps:user-A", JSON.stringify(FULL_CAPS));
    await env.CACHE.put("caps:user-B", JSON.stringify(FULL_CAPS));
    const sidA = await insertSub({ userId: "user-A", sourceType: "personal_all", sourceId: "user-A" });
    const sidB = await insertSub({ userId: "user-B", sourceType: "personal_all", sourceId: "user-B" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue(okHarvest()); // semesterInfo.id = "sess-1"
    const preGen = vi.spyOn(syncModule, "preGenerateIcs");

    const { batch } = makeBatch([
      { subscriptionId: sidA, userId: "user-A" },
      { subscriptionId: sidB, userId: "user-B" },
    ]);
    await processScheduleSyncBatch(batch, env as unknown as Env);
    await env.CACHE.delete("caps:user-A");
    await env.CACHE.delete("caps:user-B");

    // Namespace is the per-user sourceId, and the two users get DIFFERENT ones.
    const namespaces = preGen.mock.calls.map((c) => c[1]);
    expect(namespaces).toContain("user-A");
    expect(namespaces).toContain("user-B");
    // Never the shared semester id.
    expect(namespaces).not.toContain("sess-1");
  });

  it("SECURITY: harvest is keyed by auth userId, never by the (untrusted) stored sourceId", async () => {
    // An attacker stored another student's 学号 as sourceId hoping to leak their
    // schedule. Harvest ignores sourceId entirely — it runs inside the auth user's
    // OWN已登录浏览器 — so only the caller's own 课表 can ever be fetched.
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "20219999" });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue(okHarvest());

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).toHaveBeenCalledWith(expect.anything(), "user-1", { deadlineAt: expect.any(Number) });
    // The forged sourceId never reaches harvest.
    expect(harvest).not.toHaveBeenCalledWith(expect.anything(), "20219999");
  });

  it("freezes external subscriptions: acks without retry, no harvest, lastSyncedAt unchanged", async () => {
    // Pre-set lastSyncedAt to a known value so we can prove the freeze does NOT
    // overwrite it (data preserved at the last-synced state, not deleted/reset).
    const frozenAt = "2024-01-01T00:00:00.000Z";
    const sid = await insertSub({
      sourceType: "instructor",
      sourceId: "T-42",
      isPersonal: false,
      lastSyncedAt: frozenAt,
    });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    // Acked (not retried — permanent skip), and no upstream harvest was attempted.
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();

    // Data frozen: lastSyncedAt unchanged (no overwrite), row not deleted.
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBe(frozenAt);
  });

  it("entitlement gate: acks without harvesting when the sync cap is revoked", async () => {
    const sid = await insertSub({ userId: "user-revoked", sourceType: "personal_all", sourceId: "user-revoked" });
    await env.CACHE.put(
      "caps:user-revoked",
      JSON.stringify({ sync: false, external: false, share: false, sub_limit: 0, share_limit: 0, sync_interval: 1440, manual_refresh: 0 }),
    );
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-revoked", trigger: "manual" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);
    await env.CACHE.delete("caps:user-revoked");

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBeNull();
    expect(row.isActive).toBe(false); // confirmed revoke flips inactive now
  });

  it("fails closed on unresolved caps: skips harvest but keeps is_active (no link flap)", async () => {
    const sid = await insertSub({ userId: "user-nocaps", sourceType: "personal_all", sourceId: "user-nocaps", isActive: true });
    await env.CACHE.delete("caps:user-nocaps");
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-nocaps", trigger: "cron" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(true);
  });

  it("acks (no retry) when the subscription no longer exists", async () => {
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue(okHarvest());
    const { batch, messages } = makeBatch([{ subscriptionId: "gone", userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
  });

  it("retries a transient HarvestError with backoff", async () => {
    await env.CACHE.delete("session:current");
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new HarvestError("CQU_WAF_BLOCKED"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("retries when harvest throws a generic (non-harvest) error", async () => {
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1" });
    vi.spyOn(harvestModule, "fetchPersonalHarvest").mockRejectedValue(new Error("upstream 500"));

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  // ── Cron idempotency guard (duplicate-enqueue protection) ──────────────────
  it("cron message: skips and acks a subscription that is not yet due (no harvest)", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ lastSyncedAt: recent });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest");

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", trigger: "cron" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).toBe(recent);
  });

  it("manual message: harvests even when the subscription is not yet due", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sid = await insertSub({ sourceType: "personal_all", sourceId: "user-1", lastSyncedAt: recent });
    const harvest = vi.spyOn(harvestModule, "fetchPersonalHarvest").mockResolvedValue(okHarvest());

    const { batch, messages } = makeBatch([{ subscriptionId: sid, userId: "user-1", trigger: "manual" }]);
    await processScheduleSyncBatch(batch, env as unknown as Env);

    expect(messages[0].ack).toHaveBeenCalled();
    expect(harvest).toHaveBeenCalledWith(expect.anything(), "user-1", { deadlineAt: expect.any(Number) });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.lastSyncedAt).not.toBe(recent);
  });
});
