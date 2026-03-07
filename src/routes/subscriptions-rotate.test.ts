import { describe, it, expect, vi } from "vitest";
import subsApp from "./subscriptions";

function mockStmt(rawRows: unknown[][] = []) {
  return {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    raw: vi.fn().mockResolvedValue(rawRows),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMockEnv(prepareImpl?: (...args: unknown[]) => unknown) {
  return {
    DB: {
      prepare: prepareImpl
        ? vi.fn(prepareImpl)
        : vi.fn().mockReturnValue(mockStmt()),
      batch: vi.fn().mockImplementation((stmts: unknown[]) =>
        Promise.all(stmts.map(() => ({ results: [] })))
      ),
    },
    AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EXPLORE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    PUBLIC_URL: "https://schedule.cqu.moe",
    HCAPTCHA_ENABLED: "false",
    CACHE: { get: vi.fn(), put: vi.fn() },
    MAX_SUBSCRIPTIONS: "10",
  } as any;
}

// requireAuth selects: id, student_id, calendar_token, created_at, last_refresh_at
// Drizzle uses raw() for .select({...}) which returns array-of-arrays
const AUTH_USER_ROW = ["u1", "20210001", "auth-token", "2026-01-01", null];

function authPost(path: string, token: string, env?: any) {
  return subsApp.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
    env ?? createMockEnv(),
  );
}

describe("POST /:sub_token/rotate (single)", () => {
  it("returns 401 without auth", async () => {
    const res = await subsApp.request(
      "/some-token/rotate",
      { method: "POST" },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when subscription not found", async () => {
    // Call sequence:
    // 1. requireAuth: SELECT user (raw) -> auth user row
    // 2. SELECT subscription by token+userId (raw) -> [] (not found)
    let callIdx = 0;
    const env = createMockEnv(() => {
      callIdx++;
      if (callIdx === 1) return mockStmt([AUTH_USER_ROW]);
      return mockStmt([]);
    });

    const res = await authPost("/nonexistent/rotate", "auth-token", env);
    expect(res.status).toBe(404);
  });
});

describe("POST /rotate-all", () => {
  it("returns 401 without auth", async () => {
    const res = await subsApp.request(
      "/rotate-all",
      { method: "POST" },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns count 0 when user has no subscriptions", async () => {
    // Call sequence:
    // 1. requireAuth: SELECT user (raw) -> auth user row
    // 2. SELECT subscriptions by userId (raw) -> [] (none)
    let callIdx = 0;
    const env = createMockEnv(() => {
      callIdx++;
      if (callIdx === 1) return mockStmt([AUTH_USER_ROW]);
      return mockStmt([]);
    });

    const res = await authPost("/rotate-all", "auth-token", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(0);
  });
});
