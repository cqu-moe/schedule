import { describe, it, expect, vi } from "vitest";
import adminApp from "./admin";

function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
        raw: vi.fn().mockResolvedValue([]),
      }),
    },
    SCHEDULE_SYNC_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as any;
}

function post(path: string, env: any, headers: Record<string, string> = {}) {
  return adminApp.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
  }, env);
}

describe("POST /refresh-all", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await post("/refresh-all", mockEnv());
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.detail.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when ADMIN_SECRET is unset", async () => {
    const res = await post("/refresh-all", mockEnv({ ADMIN_SECRET: undefined }), {
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

  it("enqueues active users and returns count", async () => {
    const env = mockEnv();
    env.DB.prepare.mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [
          { id: "u1", student_id: "s1", access_token: "t1" },
          { id: "u2", student_id: "s2", access_token: "t2" },
        ],
      }),
      raw: vi.fn().mockResolvedValue([
        ["u1", "s1"],
        ["u2", "s2"],
      ]),
    });
    const res = await post("/refresh-all", env, {
      Authorization: "Bearer test-secret",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enqueued).toBe(2);
    expect(env.SCHEDULE_SYNC_QUEUE.sendBatch).toHaveBeenCalledTimes(1);
  });

  it("returns partial count when sendBatch fails mid-enqueue", async () => {
    const env = mockEnv();
    env.DB.prepare.mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [{ id: "u1", student_id: "s1", access_token: "t1" }],
      }),
      raw: vi.fn().mockResolvedValue([["u1", "s1"]]),
    });
    env.SCHEDULE_SYNC_QUEUE.sendBatch.mockRejectedValue(new Error("Queue unavailable"));
    const res = await post("/refresh-all", env, {
      Authorization: "Bearer test-secret",
    });
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.enqueued).toBe(0);
    expect(body.error).toContain("Failed after enqueuing");
  });

  it("returns enqueued: 0 when no active users", async () => {
    const env = mockEnv();
    const res = await post("/refresh-all", env, {
      Authorization: "Bearer test-secret",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enqueued).toBe(0);
    expect(env.SCHEDULE_SYNC_QUEUE.sendBatch).not.toHaveBeenCalled();
  });
});
