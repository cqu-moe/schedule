import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("canonical personal subscription schema", () => {
  it("allows one canonical per user and three distinct views", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,created_at,updated_at)
      VALUES ('canonical-one','u-one','personal','u-one','个人课表',1,?,?)`)
      .bind(now, now)
      .run();

    await expect(env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,created_at,updated_at)
      VALUES ('duplicate','u-one','personal','u-one','个人课表',1,?,?)`)
      .bind(now, now)
      .run()).rejects.toThrow();

    await env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,created_at,updated_at)
      VALUES ('canonical-two','u-two','personal','u-two','个人课表',1,?,?)`)
      .bind(now, now)
      .run();

    for (const type of ["personal_all", "personal_courses", "personal_exams"] as const) {
      await env.DB.prepare(`INSERT INTO personal_subscription_views
        (id,subscription_id,source_type,source_name,created_at)
        VALUES (?,?,?,?,?)`)
        .bind(`view-${type}`, "canonical-one", type, type, now)
        .run();
    }

    await expect(env.DB.prepare(`INSERT INTO personal_subscription_views
      (id,subscription_id,source_type,source_name,created_at)
      VALUES ('view-duplicate','canonical-one','personal_all','duplicate',?)`)
      .bind(now)
      .run()).rejects.toThrow();

    const views = await env.DB.prepare(
      "SELECT source_type FROM personal_subscription_views WHERE subscription_id=? ORDER BY source_type",
    ).bind("canonical-one").all<{ source_type: string }>();
    expect(views.results.map((view) => view.source_type)).toEqual([
      "personal_all",
      "personal_courses",
      "personal_exams",
    ]);
  });

  it("enforces personal view scope on links while external links remain unscoped", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,created_at,updated_at)
      VALUES ('external','u-external','course','course-1','课程',?,?)`)
      .bind(now, now)
      .run();
    await env.DB.prepare(`INSERT INTO calendar_links
      (id,subscription_id,token,formats,is_default,personal_view_type,created_at,updated_at)
      VALUES ('external-link','external','external-token','["ics"]',1,NULL,?,?)`)
      .bind(now, now)
      .run();

    const external = await env.DB.prepare(
      "SELECT personal_view_type FROM calendar_links WHERE id='external-link'",
    ).first<{ personal_view_type: string | null }>();
    expect(external?.personal_view_type).toBeNull();

    await expect(env.DB.prepare(`INSERT INTO calendar_links
      (id,subscription_id,token,formats,is_default,personal_view_type,created_at,updated_at)
      VALUES ('bad-link','external','bad-token','["ics"]',0,'personal_invalid',?,?)`)
      .bind(now, now)
      .run()).rejects.toThrow();
  });
});
