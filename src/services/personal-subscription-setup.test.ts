import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  calendarLinks,
  personalSubscriptionSetup,
  subscriptions,
} from "../db/schema";
import { EntitlementError } from "../middleware/entitlements";
import type { CalendarCaps } from "./auth-rpc";
import {
  getPersonalSetup,
  prepareDefaultSubscriptions,
  summarizePersonalSetup,
} from "./personal-subscription-setup";
import type { Env } from "../types";

const FULL_CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: true,
  sub_limit: 10,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

const db = drizzle(env.DB);
const setupEnv = { ...env, DB: env.DB } as unknown as Env;

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_setup").run();
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_views").run();
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_migration_backups").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();
  await env.DB.prepare(`CREATE TABLE subscriptions (
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
    sync_status text NOT NULL DEFAULT 'idle',
    sync_run_id text,
    sync_trigger text,
    sync_requested_at text,
    sync_started_at text,
    sync_finished_at text,
    sync_error_code text,
    sync_error_message text,
    manual_refresh_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX uq_user_source_personal ON subscriptions (user_id, source_type, source_id) WHERE source_type IN ('personal_all', 'personal_courses', 'personal_exams')",
  ).run();
  await env.DB.prepare(
    "CREATE UNIQUE INDEX uq_personal_subscription_user ON subscriptions (user_id) WHERE source_type='personal'",
  ).run();
  await env.DB.prepare(`CREATE TABLE personal_subscription_views (
    id text PRIMARY KEY NOT NULL, subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_type text NOT NULL, source_name text NOT NULL, created_at text NOT NULL,
    UNIQUE(subscription_id, source_type)
  )`).run();
  await env.DB.prepare(`CREATE TABLE personal_subscription_migration_backups (
    user_id text PRIMARY KEY NOT NULL, subscriptions_json text NOT NULL,
    links_json text NOT NULL, setup_json text, migrated_at text NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE calendar_links (
    id text PRIMARY KEY NOT NULL,
    subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    label text,
    formats text NOT NULL,
    personal_view_type text,
    is_default integer NOT NULL DEFAULT 0,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE personal_subscription_setup (
    user_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created','existing')),
    subscription_ids TEXT NOT NULL DEFAULT '[]',
    run_id TEXT,
    dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending','sending','sent','failed')),
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM personal_subscription_setup").run();
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM personal_subscription_views").run();
  await env.DB.prepare("DELETE FROM personal_subscription_migration_backups").run();
  await env.DB.prepare("DELETE FROM subscriptions").run();
});

afterEach(() => vi.restoreAllMocks());

async function insertLegacySubscription(userId: string) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(subscriptions).values({
    id,
    userId,
    sourceType: "personal_all",
    sourceId: userId,
    sourceName: "已有订阅",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("prepareDefaultSubscriptions", () => {
  it("provisions one canonical row and three views in enabled mode regardless of quota", async () => {
    const enabledEnv = {
      ...setupEnv,
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
    } as Env;
    const caps = { ...FULL_CAPS, sub_limit: 0 };

    const first = await prepareDefaultSubscriptions(enabledEnv, "userA", caps, "active");
    const second = await prepareDefaultSubscriptions(enabledEnv, "userA", caps, "active");

    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, "userA"));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe("personal");
    expect(first.subscription_ids).toHaveLength(3);
    expect(second.subscription_ids).toEqual(first.subscription_ids);
    expect(second.run_id).toBe(first.run_id);
    expect(await db.select().from(calendarLinks)).toHaveLength(3);
  });

  it.each([
    ["unbound", "CQU_BINDING_REQUIRED"],
    [undefined, "CQU_BINDING_STATUS_UNKNOWN"],
  ] as const)("persists %s binding state without queueing", async (bindingStatus, errorCode) => {
    const enabledEnv = {
      ...setupEnv,
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
    } as Env;
    const result = await prepareDefaultSubscriptions(
      enabledEnv,
      "userA",
      FULL_CAPS,
      bindingStatus,
    );
    const [row] = await db.select().from(subscriptions);
    expect(row.syncStatus).toBe("error");
    expect(row.syncErrorCode).toBe(errorCode);
    expect(result.run_id).toBeNull();
    expect(result.dispatch_status).toBe("sent");
  });

  it("clears a stale initial setup run while binding is unavailable", async () => {
    const enabledEnv = { ...setupEnv, PERSONAL_SUBSCRIPTION_MODE: "enabled" } as Env;
    const first = await prepareDefaultSubscriptions(enabledEnv, "userA", FULL_CAPS, "active");
    await env.DB.prepare(`UPDATE subscriptions SET sync_status='error',
      sync_requested_at='2020-01-01T00:00:00.000Z',sync_error_code='CQU_BINDING_REQUIRED'
      WHERE user_id='userA'`).run();

    const blocked = await prepareDefaultSubscriptions(enabledEnv, "userA", FULL_CAPS, "unbound");
    expect(first.run_id).not.toBeNull();
    expect(blocked.run_id).toBeNull();
    expect(blocked.dispatch_status).toBe("sent");
  });

  it("creates three personal views atomically for the session user", async () => {
    const result = await prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS);

    expect(result.status).toBe("created");
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, "userA"));
    expect(rows.map((row) => row.sourceType).sort()).toEqual([
      "personal_all",
      "personal_courses",
      "personal_exams",
    ]);
    expect(rows.every((row) => row.sourceId === "userA")).toBe(true);
    expect(new Set(rows.map((row) => row.syncRunId)).size).toBe(1);
    const links = await db.select().from(calendarLinks);
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.isDefault)).toBe(true);
    expect(result.dispatch_status).toBe("pending");
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(1);
  });

  it("is idempotent without rotating ids or link tokens", async () => {
    const first = await prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS);
    const firstLinks = await db.select().from(calendarLinks);
    const second = await prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS);
    const secondLinks = await db.select().from(calendarLinks);

    expect(first.status).toBe("created");
    expect(second.status).toBe("resumed");
    expect(second.subscription_ids).toEqual(first.subscription_ids);
    expect(secondLinks.map((link) => link.id).sort()).toEqual(firstLinks.map((link) => link.id).sort());
    expect(secondLinks.map((link) => link.token).sort()).toEqual(firstLinks.map((link) => link.token).sort());
    expect(await db.select().from(subscriptions)).toHaveLength(3);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(1);
  });

  it("serializes two concurrent setup requests for one user", async () => {
    const results = await Promise.all([
      prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS),
      prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["created", "resumed"]);
    expect(results[0].subscription_ids).toEqual(results[1].subscription_ids);
    expect(await db.select().from(subscriptions)).toHaveLength(3);
    expect(await db.select().from(calendarLinks)).toHaveLength(3);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(1);
  });

  it("keeps concurrent users isolated", async () => {
    await Promise.all([
      prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS),
      prepareDefaultSubscriptions(setupEnv, "userB", FULL_CAPS),
    ]);

    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.userId === "userA").every((row) => row.sourceId === "userA")).toBe(true);
    expect(rows.filter((row) => row.userId === "userB").every((row) => row.sourceId === "userB")).toBe(true);
  });

  it("skips setup without sync entitlement and writes nothing", async () => {
    const result = await prepareDefaultSubscriptions(setupEnv, "userA", {
      ...FULL_CAPS,
      sync: false,
    });
    expect(result).toEqual({
      status: "skipped",
      subscription_ids: [],
      run_id: null,
      dispatch_status: "none",
    });
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(0);
  });

  it.each([0, 1, 2])("rejects an insufficient quota of %s without partial rows", async (subLimit) => {
    await expect(prepareDefaultSubscriptions(setupEnv, "userA", {
      ...FULL_CAPS,
      sub_limit: subLimit,
    })).rejects.toMatchObject<Partial<EntitlementError>>({
      code: "QUOTA_EXCEEDED",
      status: 409,
      message: "订阅额度不足，无法准备三个个人订阅",
    });
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await db.select().from(calendarLinks)).toHaveLength(0);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(0);
  });

  it.each([3, null])("creates all defaults with a quota of %s", async (subLimit) => {
    const result = await prepareDefaultSubscriptions(setupEnv, "userA", {
      ...FULL_CAPS,
      sub_limit: subLimit,
    });
    expect(result.status).toBe("created");
    expect(await db.select().from(subscriptions)).toHaveLength(3);
  });

  it("records an existing subscription without filling missing defaults", async () => {
    const legacyId = await insertLegacySubscription("userA");
    const result = await prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS);

    expect(result).toEqual({
      status: "existing",
      subscription_ids: [],
      run_id: null,
      dispatch_status: "sent",
    });
    expect((await db.select().from(subscriptions)).map((row) => row.id)).toEqual([legacyId]);
    expect(await db.select().from(calendarLinks)).toHaveLength(0);
  });

  it("does not restore a deleted default after setup exists", async () => {
    const first = await prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS);
    await db.delete(subscriptions).where(eq(subscriptions.id, first.subscription_ids[0]));

    const second = await prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS);
    expect(second.status).toBe("resumed");
    expect(second.subscription_ids).toEqual(first.subscription_ids);
    expect(await db.select().from(subscriptions)).toHaveLength(2);
  });

  it("rolls back setup and subscriptions when generated link tokens collide in the batch", async () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
      return array;
    });

    await expect(prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS)).rejects.toThrow();
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await db.select().from(calendarLinks)).toHaveLength(0);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(0);
  });

  it("rethrows a database failure when no competing setup committed", async () => {
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async () => { throw new Error("forced batch failure"); }),
    } as unknown as D1Database;
    await expect(prepareDefaultSubscriptions(
      { ...setupEnv, DB: failingDb },
      "userA",
      FULL_CAPS,
    )).rejects.toThrow("forced batch failure");
    expect(await getPersonalSetup(env.DB, "userA")).toBeNull();
  });

  it("rejects a corrupted stored subscription id list", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO personal_subscription_setup
      (user_id,status,subscription_ids,dispatch_status,created_at,updated_at)
      VALUES (?,'created',?,'pending',?,?)`)
      .bind("userA", "not-json", now, now)
      .run();
    const row = await getPersonalSetup(env.DB, "userA");
    expect(row).not.toBeNull();
    expect(() => summarizePersonalSetup(row!)).toThrow("PERSONAL_SETUP_INVALID_SUBSCRIPTION_IDS");
    await expect(prepareDefaultSubscriptions(setupEnv, "userA", FULL_CAPS))
      .rejects.toThrow("PERSONAL_SETUP_INVALID_SUBSCRIPTION_IDS");
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });
});
