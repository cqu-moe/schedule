import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { PERSONAL_VIEW_TYPES, type PersonalViewType } from "../db/schema";
import { resetPersonalData, readPersonalRows } from "../../tests/fixtures/personal-subscriptions";
import { migratePersonalUser, runPersonalMigration } from "./personal-subscription-migration";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetPersonalData(env.DB);
});

async function seedLegacySet(userId: string, types: PersonalViewType[]) {
  const ids: string[] = [];
  const tokens: string[] = [];
  const freshnessByType = new Map<PersonalViewType, string>();
  for (const [index, type] of types.entries()) {
    const id = crypto.randomUUID();
    const token = `legacy-${crypto.randomUUID()}`;
    const now = new Date(Date.now() + index * 1000).toISOString();
    ids.push(id);
    tokens.push(token);
    freshnessByType.set(type, now);
    await env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,is_active,
       semester_start,session_id,session_name,courses_json,exams_json,last_synced_at,
       sync_status,manual_refresh_at,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1,'2026-09-01','term-1','测试学期',?,?,?,'success',?,?,?)`)
      .bind(
        id,
        userId,
        type,
        userId,
        type,
        type === "personal_exams" ? null : "[]",
        type === "personal_courses" || type === "personal_exams" ? null : "[]",
        now,
        now,
        now,
        now,
      )
      .run();
    await env.DB.prepare(`INSERT INTO calendar_links
      (id,subscription_id,token,formats,is_default,created_at,updated_at)
      VALUES (?,?,?,'["ics","origin_json","data_json","csv","web"]',1,?,?)`)
      .bind(crypto.randomUUID(), id, token, now, now)
      .run();
  }
  return { ids, tokens, freshnessByType };
}

const cases: Array<{ types: PersonalViewType[] }> = [
  { types: ["personal_all"] },
  { types: ["personal_courses"] },
  { types: ["personal_exams"] },
  { types: ["personal_all", "personal_courses"] },
  { types: ["personal_all", "personal_exams"] },
  { types: ["personal_courses", "personal_exams"] },
  { types: ["personal_all", "personal_courses", "personal_exams"] },
];

describe("personal subscription migration", () => {
  it.each(cases)("fills all built-in views for $types", async ({ types }) => {
    const before = await seedLegacySet("legacy-user", types);
    await migratePersonalUser({
      ...env,
      PERSONAL_SUBSCRIPTION_MODE: "migration",
    } as never, "legacy-user", true);

    expect(await readPersonalRows(env.DB, "legacy-user")).toHaveLength(1);
    const views = await env.DB.prepare(`SELECT id,source_type FROM personal_subscription_views
      WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id=?)`)
      .bind("legacy-user")
      .all<{ id: string; source_type: string }>();
    expect(views.results).toHaveLength(3);
    expect(views.results.map((view) => view.source_type).sort()).toEqual([...PERSONAL_VIEW_TYPES].sort());
    for (const id of before.ids) {
      expect(views.results.some((view) => view.id === id)).toBe(true);
    }
    const links = await env.DB.prepare("SELECT token,personal_view_type FROM calendar_links")
      .all<{ token: string; personal_view_type: string }>();
    for (const token of before.tokens) {
      expect(links.results.some((link) => link.token === token)).toBe(true);
    }
    const canonical = await env.DB.prepare(`SELECT sync_status,last_synced_at,exams_json
      FROM subscriptions WHERE user_id=? AND source_type='personal'`)
      .bind("legacy-user")
      .first<{ sync_status: string; last_synced_at: string | null; exams_json: string | null }>();
    const shouldBeComplete = types.includes("personal_all")
      || (types.includes("personal_courses") && types.includes("personal_exams"));
    expect(canonical?.sync_status).toBe(shouldBeComplete ? "success" : "error");
    expect(canonical?.last_synced_at === null).toBe(!shouldBeComplete);
    if (types.includes("personal_all") || types.includes("personal_exams")) {
      expect(canonical?.exams_json).toBe("[]");
    }
    if (types.includes("personal_courses") && types.includes("personal_exams") && !types.includes("personal_all")) {
      expect(canonical?.last_synced_at).toBe(before.freshnessByType.get("personal_courses"));
    }
  });

  it("rolls back backup, views, link moves, setup, and survivor changes on a late batch failure", async () => {
    const before = await seedLegacySet("rollback-user", ["personal_courses", "personal_exams"]);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO personal_subscription_setup
      (user_id,status,subscription_ids,dispatch_status,created_at,updated_at)
      VALUES ('rollback-user','existing','[]','sent',?,?)`)
      .bind(now, now).run();
    const originalRows = await env.DB.prepare(`SELECT id,source_type FROM subscriptions
      WHERE user_id='rollback-user' ORDER BY id`).all();
    const originalLinks = await env.DB.prepare(`SELECT id,subscription_id,token FROM calendar_links
      ORDER BY id`).all();
    const originalSetup = await env.DB.prepare(`SELECT * FROM personal_subscription_setup
      WHERE user_id='rollback-user'`).first();
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: (statements: D1PreparedStatement[]) => env.DB.batch([
        ...statements,
        env.DB.prepare(`INSERT INTO subscriptions
          (id,user_id,source_type,source_id,source_name,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?)`)
          .bind(before.ids[0], "conflict", "course", "x", "late failure", now, now),
      ]),
    } as unknown as D1Database;

    await expect(migratePersonalUser({
      ...env,
      DB: failingDb,
      PERSONAL_SUBSCRIPTION_MODE: "migration",
    } as never, "rollback-user", true)).rejects.toThrow();

    expect((await env.DB.prepare(`SELECT id,source_type FROM subscriptions
      WHERE user_id='rollback-user' ORDER BY id`).all()).results).toEqual(originalRows.results);
    expect((await env.DB.prepare(`SELECT id,subscription_id,token FROM calendar_links
      ORDER BY id`).all()).results).toEqual(originalLinks.results);
    expect(await env.DB.prepare(`SELECT * FROM personal_subscription_setup
      WHERE user_id='rollback-user'`).first()).toEqual(originalSetup);
    expect(Number((await env.DB.prepare(`SELECT count(*) AS count
      FROM personal_subscription_migration_backups`).first<{ count: number }>())?.count)).toBe(0);
    expect(Number((await env.DB.prepare(`SELECT count(*) AS count
      FROM personal_subscription_views`).first<{ count: number }>())?.count)).toBe(0);
  });

  it("is idempotent and global verify reports no legacy rows or missing tokens", async () => {
    await seedLegacySet("legacy-user", ["personal_courses", "personal_exams"]);
    const migrationEnv = { ...env, PERSONAL_SUBSCRIPTION_MODE: "migration" } as never;
    await migratePersonalUser(migrationEnv, "legacy-user", true);
    expect((await migratePersonalUser(migrationEnv, "legacy-user", true)).users).toBe(0);
    const verified = await runPersonalMigration(migrationEnv, {
      mode: "verify",
      after_user_id: null,
      limit: 10,
    });
    expect(verified.complete).toBe(true);
    expect(verified.verification).toMatchObject({
      legacy_rows: 0,
      missing_views: 0,
      missing_defaults: 0,
      missing_tokens: 0,
      foreign_key_violations: 0,
    });
  });
});
