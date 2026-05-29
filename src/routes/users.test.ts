import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNull } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import { encrypt } from "../services/crypto";

// ── Mocks for HTTP route tests (hoisted; harmless to syncNewUserSubscriptions) ──
// Captcha disabled via env, but stub the module so no network call ever happens.
vi.mock("../services/captcha", () => ({
  verifyCaptcha: vi.fn().mockResolvedValue(undefined),
  CaptchaError: class CaptchaError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CaptchaError";
    }
  },
}));
// login() is controlled per-test; AuthError preserved for handleAuthError.
const loginMock = vi.fn();
vi.mock("../services/auth", () => ({
  login: (...args: unknown[]) => loginMock(...args),
  AuthError: class AuthError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "AuthError";
      this.code = code;
    }
  },
}));

import usersApp, { syncNewUserSubscriptions } from "./users";
import type { Env } from "../types";

const TEST_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

// ── Mock CQU API responses ──────────────────────────────────────────

const MOCK_SESSION_LIST = {
  curSessionId: "1029",
  sessionFinder: [
    { id: "1029", name: "2025-2026学年春季学期" },
  ],
};

const MOCK_SEMESTER_INFO = {
  data: {
    id: "1029",
    year: "2025-2026学年",
    term: "春季学期",
    beginDate: "2026-02-23 00:00:00",
    endDate: "2026-07-05 00:00:00",
  },
};

const MOCK_SCHEDULE = {
  classTimetableVOList: [
    {
      courseName: "高等数学",
      instructorName: "张三-01",
      roomName: "D1234",
      position: "虎溪校区",
      weekDay: 1,
      period: "11000000000000",
      teachingWeek: "1111111111111111",
    },
  ],
};

const MOCK_EXAMS = {
  status: "success",
  data: {
    content: [],
  },
};

/** Create a fetch mock that returns different responses based on URL */
function createCquApiFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    let body: unknown;

    if (typeof url === "string" && url.includes("session/info-detail")) {
      body = MOCK_SESSION_LIST;
    } else if (typeof url === "string" && url.includes("session/info/")) {
      body = MOCK_SEMESTER_INFO;
    } else if (typeof url === "string" && url.includes("my-table-detail")) {
      body = MOCK_SCHEDULE;
    } else if (typeof url === "string" && url.includes("exam")) {
      body = MOCK_EXAMS;
    } else {
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    }

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

// ── Test setup ──────────────────────────────────────────────────────

describe("syncNewUserSubscriptions", () => {
  const db = drizzle(env.DB);
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL,
        student_id text NOT NULL,
        encrypted_password text NOT NULL,
        auth_user_id text,
        auth_refresh_token text,
        auth_refresh_issued_at text,
        access_token text,
        refresh_token text,
        token_expires_at text,
        calendar_token text NOT NULL,
        pending_calendar_token text,
        pending_token_expires_at text,
        last_login_at text,
        last_refresh_at text,
        login_error text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_unique ON users (auth_user_id)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_password_student_id ON users (student_id) WHERE auth_user_id IS NULL`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_calendar_token_unique ON users (calendar_token)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_pending_calendar_token_unique ON users (pending_calendar_token)`,
    ).run();

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type text NOT NULL,
        source_id text NOT NULL,
        source_name text NOT NULL,
        calendar_token text NOT NULL,
        session_id text,
        session_name text,
        semester_start text,
        is_personal integer NOT NULL DEFAULT 0,
        ics_content text,
        courses_json text,
        exams_json text,
        last_synced_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_calendar_token_unique ON subscriptions (calendar_token)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_source_session ON subscriptions (user_id, source_type, source_id, session_id)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_user_source ON subscriptions (user_id, source_type) WHERE is_personal = 1`,
    ).run();
  });

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function insertUserWithSubs() {
    const userId = crypto.randomUUID();
    const encryptedPw = await encrypt("test-pw", TEST_KEY);
    const now = new Date().toISOString();

    await db.insert(users).values({
      id: userId,
      studentId: "20210001",
      encryptedPassword: encryptedPw,
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      tokenExpiresAt: new Date(Date.now() + 4 * 3600000).toISOString(),
      calendarToken: crypto.randomUUID() + crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });

    const subIds: { id: string; sourceType: string }[] = [];
    for (const sourceType of ["personal_all", "personal_courses", "personal_exams"]) {
      const subId = crypto.randomUUID();
      await db.insert(subscriptions).values({
        id: subId,
        userId,
        sourceType,
        sourceId: "20210001",
        sourceName: sourceType,
        calendarToken: crypto.randomUUID() + crypto.randomUUID(),
        isPersonal: true,
        createdAt: now,
        updatedAt: now,
      });
      subIds.push({ id: subId, sourceType });
    }

    return { userId, subIds };
  }

  it("should populate icsContent for all 3 personal subscriptions", async () => {
    globalThis.fetch = createCquApiFetchMock();
    const { userId, subIds } = await insertUserWithSubs();

    const mockKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      CACHE: mockKv,
    } as unknown as Env;

    await syncNewUserSubscriptions(testEnv, userId, "20210001", "test-access-token", subIds);

    // Verify all subscriptions have icsContent
    for (const sub of subIds) {
      const [updated] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, sub.id));

      expect(updated.icsContent).not.toBeNull();
      expect(updated.icsContent).toContain("BEGIN:VCALENDAR");
      expect(updated.lastSyncedAt).not.toBeNull();
      expect(updated.sessionId).toBe("1029");
      expect(updated.sessionName).toBe("2025-2026学年春季学期");
    }
  });

  it("should update user.lastRefreshAt", async () => {
    globalThis.fetch = createCquApiFetchMock();
    const { userId, subIds } = await insertUserWithSubs();

    const mockKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      CACHE: mockKv,
    } as unknown as Env;

    await syncNewUserSubscriptions(testEnv, userId, "20210001", "test-access-token", subIds);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user.lastRefreshAt).not.toBeNull();
  });

  it("should use KV cache for session context", async () => {
    globalThis.fetch = createCquApiFetchMock();
    const { userId, subIds } = await insertUserWithSubs();

    const mockKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      CACHE: mockKv,
    } as unknown as Env;

    await syncNewUserSubscriptions(testEnv, userId, "20210001", "test-access-token", subIds);

    // Should have attempted to read cache, then written to it
    expect(mockKv.get).toHaveBeenCalledWith("session:current", "json");
    expect(mockKv.put).toHaveBeenCalledOnce();
  });

  it("should not throw on API failure (error is caught and logged)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const { userId, subIds } = await insertUserWithSubs();

    const mockKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      CACHE: mockKv,
    } as unknown as Env;

    // Should not throw
    await syncNewUserSubscriptions(testEnv, userId, "20210001", "test-access-token", subIds);

    // Subscriptions should remain without icsContent
    for (const sub of subIds) {
      const [unchanged] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, sub.id));
      expect(unchanged.icsContent).toBeNull();
    }
  });

  it("should populate coursesJson for personal_courses subscription", async () => {
    globalThis.fetch = createCquApiFetchMock();
    const { userId, subIds } = await insertUserWithSubs();

    const mockKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      CACHE: mockKv,
    } as unknown as Env;

    await syncNewUserSubscriptions(testEnv, userId, "20210001", "test-access-token", subIds);

    const coursesSub = subIds.find(s => s.sourceType === "personal_courses")!;
    const [updated] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, coursesSub.id));

    expect(updated.coursesJson).not.toBeNull();
    const courses = JSON.parse(updated.coursesJson!);
    expect(courses).toHaveLength(1);
    expect(courses[0].name).toBe("高等数学");

    // personal_courses should not have examsJson
    expect(updated.examsJson).toBeNull();
  });
});

// ── Password flows scoped to non-auth accounts (auth_user_id IS NULL) ─────────
// Security: a studentId may exist as BOTH a password account (auth_user_id NULL)
// and an AUTH account (auth_user_id set, encrypted_password = "" sentinel).
// Password register/recover/recover-verify must ONLY ever touch the password row.
describe("password flows scoped to non-auth accounts", () => {
  const db = drizzle(env.DB);

  const STUDENT = "20210099";
  const AUTH_SUB = "auth-sub-xyz";
  let authCalendarToken: string;

  function routeEnv() {
    return {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      HCAPTCHA_ENABLED: "false",
      UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    } as unknown as Env;
  }

  // No-op executionCtx so register's waitUntil(syncNewUserSubscriptions) doesn't throw.
  const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  function post(path: string, body: Record<string, unknown>) {
    return usersApp.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      routeEnv(),
      noopCtx,
    );
  }

  beforeAll(async () => {
    // Tables are created by the syncNewUserSubscriptions suite's beforeAll, but be
    // self-contained in case ordering changes: CREATE ... IF NOT EXISTS is idempotent.
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL,
        student_id text NOT NULL,
        encrypted_password text NOT NULL,
        auth_user_id text,
        auth_refresh_token text,
        auth_refresh_issued_at text,
        access_token text,
        refresh_token text,
        token_expires_at text,
        calendar_token text NOT NULL,
        pending_calendar_token text,
        pending_token_expires_at text,
        last_login_at text,
        last_refresh_at text,
        login_error text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_password_student_id ON users (student_id) WHERE auth_user_id IS NULL`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_unique ON users (auth_user_id)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_calendar_token_unique ON users (calendar_token)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS subscriptions (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type text NOT NULL,
        source_id text NOT NULL,
        source_name text NOT NULL,
        calendar_token text NOT NULL,
        session_id text,
        session_name text,
        semester_start text,
        is_personal integer NOT NULL DEFAULT 0,
        ics_content text,
        courses_json text,
        exams_json text,
        last_synced_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_calendar_token_unique ON subscriptions (calendar_token)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_source_session ON subscriptions (user_id, source_type, source_id, session_id)`,
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_user_source ON subscriptions (user_id, source_type) WHERE is_personal = 1`,
    ).run();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM users").run();

    // Seed an AUTH-account row sharing STUDENT's studentId.
    authCalendarToken = "auth-" + crypto.randomUUID() + crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: crypto.randomUUID(),
      studentId: STUDENT,
      encryptedPassword: "", // sentinel for auth accounts
      authUserId: AUTH_SUB,
      authRefreshToken: "auth-refresh",
      calendarToken: authCalendarToken,
      createdAt: now,
      updatedAt: now,
    });
  });

  /** Re-fetch the AUTH row to assert it is untouched. */
  async function getAuthRow() {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.authUserId, AUTH_SUB))
      .limit(1);
    return row;
  }

  /** Fetch the password row (auth_user_id IS NULL) for STUDENT, if any. */
  async function getPasswordRow() {
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.studentId, STUDENT), isNull(users.authUserId)))
      .limit(1);
    return row;
  }

  // ── Register ───────────────────────────────────────────────────────────────
  describe("POST / (register)", () => {
    it("creates a password row and returns ITS token, not the auth row's", async () => {
      loginMock.mockResolvedValue({
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });

      const res = await post("/", { student_id: STUDENT, password: "pw123" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { calendar_token: string };

      // Returned token must NOT be the auth row's token.
      expect(body.calendar_token).not.toBe(authCalendarToken);

      // A distinct password row now exists with that token.
      const pwRow = await getPasswordRow();
      expect(pwRow).toBeDefined();
      expect(pwRow.calendarToken).toBe(body.calendar_token);
      expect(pwRow.authUserId).toBeNull();
      expect(pwRow.encryptedPassword).not.toBe("");

      // The auth row is completely untouched.
      const authRow = await getAuthRow();
      expect(authRow.calendarToken).toBe(authCalendarToken);
      expect(authRow.encryptedPassword).toBe("");
      expect(authRow.accessToken).toBeNull();
    });

    it("updates the existing password row (not the auth row) on re-register", async () => {
      // Seed an existing password row too.
      const pwToken = "pw-" + crypto.randomUUID() + crypto.randomUUID();
      const now = new Date().toISOString();
      const pwId = crypto.randomUUID();
      await db.insert(users).values({
        id: pwId,
        studentId: STUDENT,
        encryptedPassword: await encrypt("old-pw", TEST_KEY),
        calendarToken: pwToken,
        createdAt: now,
        updatedAt: now,
      });

      loginMock.mockResolvedValue({
        accessToken: "acc2",
        refreshToken: "ref2",
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });

      const res = await post("/", { student_id: STUDENT, password: "newpw" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calendar_token: string };

      // Returns the existing PASSWORD row's token, not the auth row's.
      expect(body.calendar_token).toBe(pwToken);
      expect(body.calendar_token).not.toBe(authCalendarToken);

      // Password row got the new OAuth tokens.
      const [pwRow] = await db.select().from(users).where(eq(users.id, pwId)).limit(1);
      expect(pwRow.accessToken).not.toBeNull();

      // Auth row untouched.
      const authRow = await getAuthRow();
      expect(authRow.calendarToken).toBe(authCalendarToken);
      expect(authRow.encryptedPassword).toBe("");
      expect(authRow.accessToken).toBeNull();
    });
  });

  // ── Recover ──────────────────────────────────────────────────────────────────
  describe("POST /recover", () => {
    it("does NOT match the auth row; returns PASSWORD_MISMATCH when no password account", async () => {
      // Only the auth row exists for STUDENT (encrypted_password = "").
      const res = await post("/recover", { student_id: STUDENT, password: "anything" });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: { error: { code: string } } };
      expect(body.detail.error.code).toBe("PASSWORD_MISMATCH");
    });

    it("matches only the password row when one exists", async () => {
      const pwToken = "pw-" + crypto.randomUUID() + crypto.randomUUID();
      const now = new Date().toISOString();
      await db.insert(users).values({
        id: crypto.randomUUID(),
        studentId: STUDENT,
        encryptedPassword: await encrypt("secret-pw", TEST_KEY),
        calendarToken: pwToken,
        createdAt: now,
        updatedAt: now,
      });

      const res = await post("/recover", { student_id: STUDENT, password: "secret-pw" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calendar_token: string };
      expect(body.calendar_token).toBe(pwToken);
      expect(body.calendar_token).not.toBe(authCalendarToken);
    });
  });

  // ── Recover / verify (SSO login path) ─────────────────────────────────────────
  describe("POST /recover/verify", () => {
    it("does NOT resolve to the auth row; returns INVALID_CREDENTIALS when no password account", async () => {
      loginMock.mockResolvedValue({
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });

      const res = await post("/recover/verify", { student_id: STUDENT, password: "pw" });
      // SSO succeeds but no PASSWORD account exists -> not found -> INVALID_CREDENTIALS.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { detail: { error: { code: string } } };
      expect(body.detail.error.code).toBe("INVALID_CREDENTIALS");

      // Auth row must be untouched (no OAuth tokens written to it).
      const authRow = await getAuthRow();
      expect(authRow.accessToken).toBeNull();
      expect(authRow.encryptedPassword).toBe("");
    });

    it("resolves to the password row and returns ITS token when a password account exists", async () => {
      const pwToken = "pw-" + crypto.randomUUID() + crypto.randomUUID();
      const now = new Date().toISOString();
      const pwId = crypto.randomUUID();
      await db.insert(users).values({
        id: pwId,
        studentId: STUDENT,
        encryptedPassword: await encrypt("old-pw", TEST_KEY),
        calendarToken: pwToken,
        createdAt: now,
        updatedAt: now,
      });

      loginMock.mockResolvedValue({
        accessToken: "acc-new",
        refreshToken: "ref-new",
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });

      const res = await post("/recover/verify", { student_id: STUDENT, password: "anything" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calendar_token: string };
      expect(body.calendar_token).toBe(pwToken);
      expect(body.calendar_token).not.toBe(authCalendarToken);

      // Password row got the new OAuth tokens; auth row untouched.
      const [pwRow] = await db.select().from(users).where(eq(users.id, pwId)).limit(1);
      expect(pwRow.accessToken).not.toBeNull();
      const authRow = await getAuthRow();
      expect(authRow.calendarToken).toBe(authCalendarToken);
      expect(authRow.accessToken).toBeNull();
    });
  });
});
