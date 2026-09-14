import { beforeAll, describe, it, expect, vi } from "vitest";
import { applyD1Migrations, env as cloudflareEnv } from "cloudflare:test";
import adminApp from "./admin";
import { resetPersonalData } from "../../tests/fixtures/personal-subscriptions";

beforeAll(async () => {
  await applyD1Migrations(cloudflareEnv.DB, cloudflareEnv.TEST_MIGRATIONS);
});

/** Build a mock Env. `subs` are the rows returned by the subscriptions select. */
function mockEnv(
  subs: { id: string; user_id: string }[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: subs }),
        raw: vi.fn().mockResolvedValue(subs.map((s) => [s.id, s.user_id])),
      }),
    },
    SCHEDULE_SYNC_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as any;
}

function post(path: string, env: any, headers: Record<string, string> = {}) {
  return adminApp.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
    env,
  );
}

describe("POST /refresh-all auth", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await post("/refresh-all", mockEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.detail.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when ADMIN_SECRET is unset", async () => {
    const res = await post("/refresh-all", mockEnv([], { ADMIN_SECRET: undefined }), {
      Authorization: "Bearer some-real-token",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong secret", async () => {
    const res = await post("/refresh-all", mockEnv(), {
      Authorization: "Bearer wrong-secret",
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /refresh-all enqueue", () => {
  it("enqueues all subscriptions and returns count", async () => {
    const env = mockEnv([
      { id: "sub1", user_id: "u1" },
      { id: "sub2", user_id: "u2" },
    ]);
    const res = await post("/refresh-all", env, { Authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.enqueued).toBe(2);
    expect(env.SCHEDULE_SYNC_QUEUE.sendBatch).toHaveBeenCalledTimes(1);

    // Each enqueued message carries { subscriptionId, userId }.
    const batch = env.SCHEDULE_SYNC_QUEUE.sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(2);
    const bodies = batch.map((m: any) => m.body);
    expect(bodies).toContainEqual({ subscriptionId: "sub1", userId: "u1" });
    expect(bodies).toContainEqual({ subscriptionId: "sub2", userId: "u2" });
  });

  it("returns enqueued: 0 when there are no subscriptions", async () => {
    const env = mockEnv([]);
    const res = await post("/refresh-all", env, { Authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.enqueued).toBe(0);
    expect(env.SCHEDULE_SYNC_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it("returns 500 when sendBatch fails", async () => {
    const env = mockEnv([{ id: "sub1", user_id: "u1" }]);
    env.SCHEDULE_SYNC_QUEUE.sendBatch.mockRejectedValue(new Error("Queue unavailable"));
    const res = await post("/refresh-all", env, { Authorization: "Bearer test-secret" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.enqueued).toBe(0); // first (only) batch failed → nothing enqueued
    expect(body.error).toContain("Failed");
  });

  it("reports the partial count when a later batch fails (not 0)", async () => {
    // 150 subs → 2 batches (100 + 50). First succeeds, second fails.
    const subs = Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, user_id: `u${i}` }));
    const env = mockEnv(subs);
    env.SCHEDULE_SYNC_QUEUE.sendBatch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Queue unavailable"));
    const res = await post("/refresh-all", env, { Authorization: "Bearer test-secret" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.enqueued).toBe(100); // first batch was queued — must NOT report 0
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
