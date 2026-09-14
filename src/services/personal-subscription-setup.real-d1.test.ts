import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import type { Env } from "../types";
import type { CalendarCaps } from "./auth-rpc";
import { prepareDefaultSubscriptions } from "./personal-subscription-setup";
import { resetPersonalData } from "../../tests/fixtures/personal-subscriptions";

const CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: true,
  sub_limit: 0,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

const setupEnv = {
  ...env,
  PERSONAL_SUBSCRIPTION_MODE: "enabled",
  SCHEDULE_SYNC_QUEUE: { send: vi.fn() },
} as unknown as Env;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetPersonalData(env.DB);
});

async function insertExistingMarker(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO personal_subscription_setup
    (user_id,status,subscription_ids,dispatch_status,created_at,updated_at)
    VALUES (?,'existing','[]','sent',?,?)`)
    .bind(userId, now, now)
    .run();
}

async function assertCanonicalProvisioned(userId: string): Promise<void> {
  const canonical = await env.DB.prepare(`SELECT count(*) AS count FROM subscriptions
    WHERE user_id=? AND source_type='personal'`).bind(userId).first<{ count: number }>();
  const views = await env.DB.prepare(`SELECT count(*) AS count FROM personal_subscription_views
    WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id=? AND source_type='personal')`)
    .bind(userId).first<{ count: number }>();
  expect(Number(canonical?.count)).toBe(1);
  expect(Number(views?.count)).toBe(3);
}

describe("enabled personal provisioning on the real migration schema", () => {
  it("reconciles setup(existing,[]) instead of treating it as a skip marker", async () => {
    await insertExistingMarker("marker-user");
    const result = await prepareDefaultSubscriptions(setupEnv, "marker-user", CAPS, "active");
    expect(result.subscription_ids).toHaveLength(3);
    await assertCanonicalProvisioned("marker-user");
  });

  it("keeps one canonical winner when an existing marker is provisioned concurrently", async () => {
    await insertExistingMarker("concurrent-marker-user");
    const results = await Promise.all([
      prepareDefaultSubscriptions(setupEnv, "concurrent-marker-user", CAPS, "active"),
      prepareDefaultSubscriptions(setupEnv, "concurrent-marker-user", CAPS, "active"),
    ]);
    expect(results[0].subscription_ids).toEqual(results[1].subscription_ids);
    await assertCanonicalProvisioned("concurrent-marker-user");
    const links = await env.DB.prepare(`SELECT count(*) AS count FROM calendar_links
      WHERE subscription_id IN (SELECT id FROM subscriptions
        WHERE user_id='concurrent-marker-user' AND source_type='personal')`)
      .first<{ count: number }>();
    expect(Number(links?.count)).toBe(3);
  });

  it("provisions an external-only user backfilled by migration 0010", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,created_at,updated_at)
      VALUES ('external-only','external-user','course','course-1','外部课程',?,?)`)
      .bind(now, now).run();
    await insertExistingMarker("external-user");
    await prepareDefaultSubscriptions(setupEnv, "external-user", CAPS, "active");
    await assertCanonicalProvisioned("external-user");
    const total = await env.DB.prepare(`SELECT count(*) AS count FROM subscriptions WHERE user_id=?`)
      .bind("external-user").first<{ count: number }>();
    expect(Number(total?.count)).toBe(2);
  });

  it("recreates the managed resource after every historical personal row was deleted", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,created_at,updated_at)
      VALUES ('deleted-legacy','deleted-user','personal_all','deleted-user','全部',1,?,?)`)
      .bind(now, now).run();
    await insertExistingMarker("deleted-user");
    await env.DB.prepare("DELETE FROM subscriptions WHERE id='deleted-legacy'").run();

    await prepareDefaultSubscriptions(setupEnv, "deleted-user", CAPS, "active");
    await assertCanonicalProvisioned("deleted-user");
  });
});
