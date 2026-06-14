import { describe, it, expect, vi } from "vitest";
import adminApp from "./admin";

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
    expect(body.enqueued).toBe(0);
    expect(body.error).toContain("Failed to enqueue");
  });
});
