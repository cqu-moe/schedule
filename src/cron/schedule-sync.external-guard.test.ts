import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { subscriptions } from "../db/schema";

// Round-4 [P1 DATA CORRUPTION] + Option A: external subscriptions must NEVER reach
// the personal-harvest path, regardless of the EXTERNAL_DISABLED flag, because there
// is no external harvest path in this architecture. Force the flag to FALSE here to
// prove the consumer (and producer) skip external UNCONDITIONALLY — not because the
// flag happens to be true. If the skip were still gated on the flag, an external sub
// would fall through to fetchPersonalHarvest + buildPersonalSyncResult and OVERWRITE
// the external public link with the OWNER's personal data.
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

describe("external hard-skip is UNCONDITIONAL (EXTERNAL_DISABLED=false)", () => {
  it("consumer: an external sub is STILL ack-skipped and NEVER personal-harvested", async () => {
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

  it("producer: a due external sub is STILL NOT enqueued, but is_active revocation still reconciles", async () => {
    // Owner LOST the `external` cap; with EXTERNAL_DISABLED=false the producer must
    // STILL reconcile is_active→false (revocation enforced) yet NOT enqueue the
    // external sub (no sync path exists). A due personal sub still enqueues.
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

    // Only the personal sub was enqueued; the external sub was NOT.
    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0] as { body: ScheduleSyncMessage }[];
    const ids = batch.map((m) => m.body.subscriptionId);
    expect(ids).toContain(personalSid);
    expect(ids).not.toContain(extSid);
  });

  it("producer: a due external sub whose owner is STILL entitled is NOT enqueued (unconditional skip)", async () => {
    // The decisive case for the UNCONDITIONAL skip: the owner still HAS the `external`
    // cap (entitled), so the entitlement gate would NOT drop it — only the hard
    // external skip can. With EXTERNAL_DISABLED=false the old flag-gated skip would
    // let this entitled external sub fall through and ENQUEUE (then the consumer
    // would personal-harvest it). The producer must skip it regardless of the flag.
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

    // Entitled external sub is STILL not enqueued — there is no external sync path.
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
