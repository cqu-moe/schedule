import { beforeAll, describe, it, expect } from "vitest";
import { applyD1Migrations, env as cloudflareEnv } from "cloudflare:test";
import adminApp from "./admin";
import { resetPersonalData } from "../../tests/fixtures/personal-subscriptions";

beforeAll(async () => {
  await applyD1Migrations(cloudflareEnv.DB, cloudflareEnv.TEST_MIGRATIONS);
});

function mockEnv(overrides: Record<string, unknown> = {}) {
  return { ADMIN_SECRET: "test-secret", ...overrides } as any;
}

function post(path: string, env: any, headers: Record<string, string> = {}) {
  return adminApp.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
    env,
  );
}

describe("admin auth middleware", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await post("/personal-subscription-migration", mockEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.detail.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when ADMIN_SECRET is unset", async () => {
    const res = await post("/personal-subscription-migration", mockEnv({ ADMIN_SECRET: undefined }), {
      Authorization: "Bearer some-real-token",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong secret", async () => {
    const res = await post("/personal-subscription-migration", mockEnv(), {
      Authorization: "Bearer wrong-secret",
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /personal-subscription-migration", () => {
  it("defaults to dry-run and applies only in migration mode", async () => {
    await resetPersonalData(cloudflareEnv.DB);
    const now = new Date().toISOString();
    await cloudflareEnv.DB.prepare(`INSERT INTO subscriptions
      (id,user_id,source_type,source_id,source_name,is_personal,created_at,updated_at)
      VALUES ('legacy-admin','admin-user','personal_all','admin-user','全部',1,?,?)`)
      .bind(now, now)
      .run();
    const migrationEnv = {
      ...cloudflareEnv,
      ADMIN_SECRET: "test-secret",
      PERSONAL_SUBSCRIPTION_MODE: "migration",
    } as never;
    const response = await adminApp.request(
      "/personal-subscription-migration",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "apply", limit: 10, after_user_id: null }),
      },
      migrationEnv,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { summary: { users: number }; complete: boolean };
    expect(body.summary.users).toBe(1);
    expect(body.complete).toBe(true);
  });
});
