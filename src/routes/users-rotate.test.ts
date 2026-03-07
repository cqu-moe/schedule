import { describe, it, expect, vi } from "vitest";

vi.mock("../services/captcha", () => ({
  verifyCaptcha: vi.fn().mockResolvedValue(undefined),
  CaptchaError: class extends Error {},
}));
vi.mock("../services/auth", () => ({
  login: vi.fn(),
  AuthError: class extends Error { code = ""; },
}));

import usersApp from "./users";

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
    HCAPTCHA_ENABLED: "false",
  } as any;
}

// requireAuth selects: id, student_id, calendar_token, created_at, last_refresh_at
// Drizzle uses raw() for .select({...}) which returns array-of-arrays
const AUTH_USER_ROW = ["u1", "20210001", "valid-token", "2026-01-01", null];

function authPost(path: string, token: string, body?: Record<string, unknown>, env?: any) {
  return usersApp.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env ?? createMockEnv(),
  );
}

describe("POST /me/rotate-token (prepare)", () => {
  it("returns 401 without auth header", async () => {
    const res = await usersApp.request(
      "/me/rotate-token",
      { method: "POST" },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await authPost("/me/rotate-token", "invalid-token");
    expect(res.status).toBe(401);
  });

  it("returns new_token on success", async () => {
    // Call sequence:
    // 1. requireAuth: SELECT (raw) -> auth user row
    // 2. tokenExists users check: SELECT (raw) -> [] (no collision)
    // 3. tokenExists subs check: SELECT (raw) -> [] (no collision)
    // 4. UPDATE pending token: run()
    let callIdx = 0;
    const env = createMockEnv(() => {
      callIdx++;
      if (callIdx === 1) return mockStmt([AUTH_USER_ROW]);
      return mockStmt([]);
    });

    const res = await authPost("/me/rotate-token", "valid-token", undefined, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.new_token).toBeDefined();
    expect(typeof body.new_token).toBe("string");
  });
});

describe("POST /me/rotate-token/confirm", () => {
  it("returns 400 without token in body", async () => {
    const env = createMockEnv(() => mockStmt([AUTH_USER_ROW]));
    const res = await authPost("/me/rotate-token/confirm", "valid-token", {}, env);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no pending token", async () => {
    let callIdx = 0;
    const env = createMockEnv(() => {
      callIdx++;
      if (callIdx === 1) return mockStmt([AUTH_USER_ROW]);
      // pending token query returns row with null pending token
      return mockStmt([[null, null]]);
    });

    const res = await authPost("/me/rotate-token/confirm", "valid-token", { token: "some-token" }, env);
    expect(res.status).toBe(404);
  });
});
