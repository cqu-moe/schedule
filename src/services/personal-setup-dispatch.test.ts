import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { calendarLinks, personalSubscriptionSetup, subscriptions } from "../db/schema";
import type { Env } from "../types";
import type { CalendarCaps } from "./auth-rpc";
import { prepareDefaultSubscriptions } from "./personal-subscription-setup";
import {
  dispatchPendingPersonalSetups,
  dispatchPersonalSetup,
} from "./personal-setup-dispatch";

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

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_setup").run();
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_views").run();
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_migration_backups").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();
  await env.DB.prepare(`CREATE TABLE subscriptions (
    id text PRIMARY KEY NOT NULL, user_id text NOT NULL, source_type text NOT NULL,
    source_id text NOT NULL, source_name text NOT NULL, session_id text, session_name text,
    semester_start text, is_personal integer NOT NULL DEFAULT 0, is_active integer NOT NULL DEFAULT 1,
    ics_content text, courses_json text, exams_json text, last_synced_at text,
    sync_status text NOT NULL DEFAULT 'idle', sync_run_id text, sync_trigger text,
    sync_requested_at text, sync_started_at text, sync_finished_at text,
    sync_error_code text, sync_error_message text,
    session_recovery_attempts integer NOT NULL DEFAULT 0, manual_refresh_at text,
    created_at text NOT NULL, updated_at text NOT NULL
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
    token text NOT NULL UNIQUE, label text, formats text NOT NULL,
    personal_view_type text,
    is_default integer NOT NULL DEFAULT 0, is_active integer NOT NULL DEFAULT 1,
    created_at text NOT NULL, updated_at text NOT NULL
  )`).run();
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
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM personal_subscription_setup").run();
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM personal_subscription_views").run();
  await env.DB.prepare("DELETE FROM personal_subscription_migration_backups").run();
  await env.DB.prepare("DELETE FROM subscriptions").run();
});

function testEnv(send = vi.fn(async () => undefined)): Env {
  return { ...env, DB: env.DB, SCHEDULE_SYNC_QUEUE: { send } } as unknown as Env;
}

async function createSetup(userId = "userA") {
  return prepareDefaultSubscriptions(testEnv(), userId, FULL_CAPS);
}

describe("dispatchPersonalSetup", () => {
  it("dispatches the one canonical row in enabled mode", async () => {
    const send = vi.fn(async () => undefined);
    const enabledEnv = {
      ...testEnv(send),
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
    } as Env;
    const setup = await prepareDefaultSubscriptions(
      enabledEnv,
      "canonical-user",
      FULL_CAPS,
      "active",
    );

    await dispatchPersonalSetup(enabledEnv, "canonical-user");

    const [canonical] = await db.select().from(subscriptions)
      .where(eq(subscriptions.userId, "canonical-user"));
    expect(canonical.sourceType).toBe("personal");
    expect(send).toHaveBeenCalledWith({
      subscriptionId: canonical.id,
      userId: "canonical-user",
      runId: setup.run_id,
      trigger: "initial",
    });
  });

  it("sends one initial message for the shared personal run", async () => {
    const setup = await createSetup();
    const send = vi.fn(async () => undefined);
    await dispatchPersonalSetup(testEnv(send), "userA");

    const all = await db.select().from(subscriptions)
      .where(eq(subscriptions.sourceType, "personal_all"));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      subscriptionId: all[0].id,
      userId: "userA",
      runId: setup.run_id,
      trigger: "initial",
    });
    const row = await db.select().from(personalSubscriptionSetup)
      .where(eq(personalSubscriptionSetup.userId, "userA")).get();
    expect(row?.dispatchStatus).toBe("sent");
    expect(row?.leaseToken).toBeNull();
  });

  it("allows only one concurrent sender for a user", async () => {
    await createSetup();
    const send = vi.fn(async () => undefined);
    const dispatchEnv = testEnv(send);
    await Promise.all([
      dispatchPersonalSetup(dispatchEnv, "userA"),
      dispatchPersonalSetup(dispatchEnv, "userA"),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not take over a valid lease", async () => {
    await createSetup();
    await env.DB.prepare(`UPDATE personal_subscription_setup
      SET dispatch_status='sending', lease_token='current-owner', lease_until=?
      WHERE user_id='userA'`)
      .bind(Date.now() + 60_000)
      .run();
    const send = vi.fn(async () => undefined);
    await dispatchPersonalSetup(testEnv(send), "userA");
    expect(send).not.toHaveBeenCalled();
  });

  it("takes over an expired lease", async () => {
    await createSetup();
    await env.DB.prepare(`UPDATE personal_subscription_setup
      SET dispatch_status='sending', lease_token='expired-owner', lease_until=0
      WHERE user_id='userA'`).run();
    const send = vi.fn(async () => undefined);
    await dispatchPersonalSetup(testEnv(send), "userA");
    expect(send).toHaveBeenCalledOnce();
  });

  it("marks a failed send without deleting subscriptions or links", async () => {
    await createSetup();
    const send = vi.fn(async () => { throw new Error("queue unavailable"); });
    await expect(dispatchPersonalSetup(testEnv(send), "userA"))
      .rejects.toThrow("queue unavailable");

    const setup = await db.select().from(personalSubscriptionSetup).get();
    expect(setup?.dispatchStatus).toBe("failed");
    expect(setup?.leaseUntil).toBeGreaterThan(Date.now());
    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.syncStatus === "error")).toBe(true);
    expect(rows.every((row) => row.syncErrorCode === "QUEUE_UNAVAILABLE")).toBe(true);
    expect(await db.select().from(calendarLinks)).toHaveLength(3);
  });

  it("retries dispatch without rotating links and restores only the initial run", async () => {
    await createSetup();
    const firstTokens = (await db.select().from(calendarLinks)).map((link) => link.token).sort();
    await expect(dispatchPersonalSetup(
      testEnv(vi.fn(async () => { throw new Error("queue unavailable"); })),
      "userA",
    )).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE personal_subscription_setup SET lease_until=0 WHERE user_id='userA'",
    ).run();
    await env.DB.prepare(
      "UPDATE subscriptions SET sync_requested_at='2020-01-01T00:00:00.000Z' WHERE user_id='userA'",
    ).run();

    const send = vi.fn(async () => undefined);
    await dispatchPersonalSetup(testEnv(send), "userA");

    expect(send).toHaveBeenCalledOnce();
    expect((await db.select().from(calendarLinks)).map((link) => link.token).sort()).toEqual(firstTokens);
    const rows = await db.select().from(subscriptions);
    expect(rows.every((row) => row.syncStatus === "queued")).toBe(true);
    expect(rows.every((row) => row.syncErrorCode === null)).toBe(true);
    expect(rows.every((row) => row.syncRequestedAt !== "2020-01-01T00:00:00.000Z")).toBe(true);
  });

  it("prevents an expired owner from overwriting a newer lease", async () => {
    await createSetup();
    let rejectFirst!: (error: Error) => void;
    const firstSend = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const send = vi.fn()
      .mockImplementationOnce(() => firstSend)
      .mockResolvedValueOnce(undefined);
    const dispatchEnv = testEnv(send);

    const first = dispatchPersonalSetup(dispatchEnv, "userA");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await env.DB.prepare(
      "UPDATE personal_subscription_setup SET lease_until=0 WHERE user_id='userA'",
    ).run();
    await dispatchPersonalSetup(dispatchEnv, "userA");
    rejectFirst(new Error("late failure"));
    await expect(first).rejects.toThrow("late failure");

    const setup = await db.select().from(personalSubscriptionSetup).get();
    expect(setup?.dispatchStatus).toBe("sent");
    const rows = await db.select().from(subscriptions);
    expect(rows.every((row) => row.syncStatus === "queued")).toBe(true);
  });

  it("marks the old setup sent without dispatch after a manual run supersedes it", async () => {
    await createSetup();
    await env.DB.prepare(`UPDATE subscriptions SET sync_run_id='manual-run',
      sync_trigger='manual', sync_status='queued' WHERE user_id='userA'`).run();
    const send = vi.fn(async () => undefined);
    await dispatchPersonalSetup(testEnv(send), "userA");

    expect(send).not.toHaveBeenCalled();
    const setup = await db.select().from(personalSubscriptionSetup).get();
    expect(setup?.dispatchStatus).toBe("sent");
    expect(await db.select().from(subscriptions)).toHaveLength(3);
  });
});

describe("dispatchPendingPersonalSetups", () => {
  it("continues with other users when one recovery send fails", async () => {
    await createSetup("userA");
    await createSetup("userB");
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);

    await dispatchPendingPersonalSetups(testEnv(send));

    expect(send).toHaveBeenCalledTimes(2);
    const rows = await db.select().from(personalSubscriptionSetup);
    expect(rows.find((row) => row.userId === "userA")?.dispatchStatus).toBe("failed");
    expect(rows.find((row) => row.userId === "userB")?.dispatchStatus).toBe("sent");
  });

  it("processes at most twenty-five eligible users per recovery pass", async () => {
    for (let index = 0; index < 26; index += 1) {
      await createSetup(`user-${index}`);
    }
    const send = vi.fn(async () => undefined);
    await dispatchPendingPersonalSetups(testEnv(send));

    expect(send).toHaveBeenCalledTimes(25);
    const unsent = await env.DB.prepare(
      "SELECT count(*) AS count FROM personal_subscription_setup WHERE dispatch_status!='sent'",
    ).first<{ count: number }>();
    expect(unsent?.count).toBe(1);
  });
});
