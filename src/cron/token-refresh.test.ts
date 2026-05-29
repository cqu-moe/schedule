import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import { encrypt, decrypt } from "../services/crypto";
import {
  enqueueTokenRefresh,
  processTokenRefreshBatch,
  type TokenRefreshMessage,
} from "./token-refresh";
import { AUTH_BASE } from "../services/oauth-constants";
import type { Env } from "../types";

// Test encryption key: 32 bytes base64-encoded
const TEST_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

/** Insert a test user into D1 with the given tokenExpiresAt */
async function insertUser(
  db: ReturnType<typeof drizzle>,
  opts: {
    studentId: string;
    tokenExpiresAt: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const encryptedPassword = await encrypt("test-password", TEST_KEY);
  const calendarToken = crypto.randomUUID() + crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id,
    studentId: opts.studentId,
    encryptedPassword,
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpiresAt: opts.tokenExpiresAt,
    calendarToken,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

describe("enqueueTokenRefresh (producer)", () => {
  const db = drizzle(env.DB);

  beforeAll(async () => {
    // Create the users table in the ephemeral D1 test database
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
  });

  beforeEach(async () => {
    // Clean users table before each test
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("should not call sendBatch when no users need refresh", async () => {
    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should not call sendBatch when users have null tokenExpiresAt", async () => {
    await insertUser(db, {
      studentId: "20210001",
      tokenExpiresAt: null,
    });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should not enqueue users whose tokens expire more than 2 hours from now", async () => {
    // Token expires 3 hours from now - well outside the 2h window
    const futureExpiry = new Date(
      Date.now() + 3 * 60 * 60 * 1000,
    ).toISOString();

    await insertUser(db, {
      studentId: "20210002",
      tokenExpiresAt: futureExpiry,
    });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should enqueue users whose tokens expire within 2 hours", async () => {
    // Token expires 1 hour from now - inside the 2h window
    const soonExpiry = new Date(
      Date.now() + 1 * 60 * 60 * 1000,
    ).toISOString();

    const userId = await insertUser(db, {
      studentId: "20210003",
      tokenExpiresAt: soonExpiry,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body).toEqual({
      userId,
      studentId: "20210003",
    });
    expect(batch[0].delaySeconds).toBe(0);
  });

  it("should enqueue users whose tokens have already expired", async () => {
    // Token expired 1 hour ago
    const pastExpiry = new Date(
      Date.now() - 1 * 60 * 60 * 1000,
    ).toISOString();

    const userId = await insertUser(db, {
      studentId: "20210004",
      tokenExpiresAt: pastExpiry,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body.userId).toBe(userId);
  });

  it("should enqueue only expiring users in a mixed set", async () => {
    // User A: expires in 30 minutes (should be enqueued)
    const expiringId = await insertUser(db, {
      studentId: "20210005",
      tokenExpiresAt: new Date(
        Date.now() + 30 * 60 * 1000,
      ).toISOString(),
    });

    // User B: expires in 5 hours (should NOT be enqueued)
    await insertUser(db, {
      studentId: "20210006",
      tokenExpiresAt: new Date(
        Date.now() + 5 * 60 * 60 * 1000,
      ).toISOString(),
    });

    // User C: null expiry (should NOT be enqueued)
    await insertUser(db, {
      studentId: "20210007",
      tokenExpiresAt: null,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].body.userId).toBe(expiringId);
    expect(batch[0].body.studentId).toBe("20210005");
  });

  it("should enqueue multiple expiring users in a single batch", async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const id1 = await insertUser(db, {
      studentId: "20210010",
      tokenExpiresAt: soon,
    });
    const id2 = await insertUser(db, {
      studentId: "20210011",
      tokenExpiresAt: soon,
    });

    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
      TOKEN_REFRESH_QUEUE: { sendBatch },
    } as unknown as Env;

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledOnce();
    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(2);

    const userIds = batch.map(
      (m: { body: { userId: string } }) => m.body.userId,
    );
    expect(userIds).toContain(id1);
    expect(userIds).toContain(id2);

    // Verify delaySeconds is set with increasing intervals
    expect(batch[0].delaySeconds).toBe(0);
    expect(batch[1].delaySeconds).toBeGreaterThan(0);
    // Interval = floor(3600 / 2) = 1800, clamped by max(5, ...)
    expect(batch[1].delaySeconds).toBe(1800);
  });
});

function mockMessage(body: TokenRefreshMessage) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function mockBatch(messages: ReturnType<typeof mockMessage>[]) {
  return {
    messages,
    queue: "test",
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<TokenRefreshMessage>;
}

describe("processTokenRefreshBatch (consumer)", () => {
  const db = drizzle(env.DB);

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
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("should ack messages for non-existent users", async () => {
    const msg = mockMessage({ userId: "nonexistent", studentId: "00000000" });
    await processTokenRefreshBatch(mockBatch([msg]), {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);
    expect(msg.ack).toHaveBeenCalled();
  });

  it("should ack messages for users that no longer need refresh", async () => {
    // Token expires in 3 hours (> 2h threshold = no refresh needed)
    const id = await insertUser(db, {
      studentId: "20210030",
      tokenExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });
    const msg = mockMessage({ userId: id, studentId: "20210030" });
    await processTokenRefreshBatch(mockBatch([msg]), {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);
    expect(msg.ack).toHaveBeenCalled();
  });
});

// ── AUTH-account branch (re-mint, D8 rotation, failure taxonomy) ──────────────

const STALE = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago = needs CQU refresh
const FRESH = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // 3h ahead = CQU fresh
const OLD_AUTH = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30d ago = needs rotation
const RECENT_AUTH = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1d ago = no rotation

function authEnv(): Env {
  return {
    ...env,
    ENCRYPTION_KEY: TEST_KEY,
    AUTH_OAUTH_CLIENT_ID: "schedule-client",
    AUTH_OAUTH_CLIENT_SECRET: "schedule-secret",
  } as unknown as Env;
}

/** Insert an AUTH account (auth_user_id non-null, sentinel "" password). */
async function insertAuthUser(
  db: ReturnType<typeof drizzle>,
  opts: {
    studentId: string;
    authUserId: string;
    tokenExpiresAt: string | null;
    authRefreshIssuedAt: string | null;
    /** plaintext auth refresh token to encrypt-and-store; null for none */
    authRefreshPlaintext?: string | null;
    /** plaintext CQU refresh token to encrypt-and-store; null for none */
    cquRefreshPlaintext?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const calendarToken = crypto.randomUUID() + crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id,
    studentId: opts.studentId,
    encryptedPassword: "", // D7 sentinel
    authUserId: opts.authUserId,
    authRefreshToken:
      opts.authRefreshPlaintext === null || opts.authRefreshPlaintext === undefined
        ? null
        : await encrypt(opts.authRefreshPlaintext, TEST_KEY),
    authRefreshIssuedAt: opts.authRefreshIssuedAt,
    accessToken: "old-access",
    refreshToken:
      opts.cquRefreshPlaintext === null
        ? null
        : await encrypt(opts.cquRefreshPlaintext ?? "cqu-refresh", TEST_KEY),
    tokenExpiresAt: opts.tokenExpiresAt,
    calendarToken,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

interface AuthFetchOpts {
  /** CQU refresh_token endpoint (my.cqu.edu.cn/authserver/oauth/token) */
  cquRefreshStatus?: number;
  cquRefreshBody?: object;
  /** auth.cqu.moe token endpoint (refresh_token grant) */
  authTokenStatus?: number;
  authTokenBody?: object;
  /** auth.cqu.moe service-ticket */
  serviceTicketStatus?: number;
  serviceTicketBody?: object;
  /** CAS dance */
  casCookie?: string;
  authorizeLocation?: string;
  cquExchangeBody?: object;
}

/**
 * Mock global fetch covering: CQU oauth/token (refresh + code-exchange share
 * the same URL — disambiguate by grant_type), auth.cqu.moe token + ticket, and
 * the CAS dance.
 */
function createAuthFetchMock(o: AuthFetchOpts = {}): typeof globalThis.fetch {
  const {
    cquRefreshStatus = 200,
    cquRefreshBody = { access_token: "cqu-at-refreshed", refresh_token: "cqu-rt-refreshed", expires_in: 14400 },
    authTokenStatus = 200,
    authTokenBody = { access_token: "auth-at-new", refresh_token: "auth-rt-new", expires_in: 3600 },
    serviceTicketStatus = 200,
    serviceTicketBody = { ticket: "ST-remint" },
    casCookie = "SESSION=sess-remint; Path=/",
    authorizeLocation = "https://my.cqu.edu.cn/workspace/token-index?code=CQUCODE&state=",
    cquExchangeBody = { access_token: "cqu-at-reminted", refresh_token: "cqu-rt-reminted", expires_in: 14400 },
  } = o;

  return vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: object, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // ── auth.cqu.moe ──
    if (url.startsWith(`${AUTH_BASE}/api/auth/oauth2/token`)) {
      return json(authTokenBody, authTokenStatus);
    }
    if (url.startsWith(`${AUTH_BASE}/api/cqu/service-ticket`)) {
      return json(serviceTicketBody, serviceTicketStatus);
    }

    // ── my.cqu.edu.cn ──
    if (url.includes("/authserver/oauth/token")) {
      // Disambiguate refresh_token grant (CQU refresh) vs code exchange.
      const body = init?.body?.toString() ?? "";
      if (body.includes("grant_type=refresh_token")) {
        return json(cquRefreshBody, cquRefreshStatus);
      }
      return json(cquExchangeBody, 200);
    }
    if (url.includes("/authserver/authentication/cas")) {
      return new Response(null, {
        status: 302,
        headers: { "Set-Cookie": casCookie, Location: "/workspace/cas" },
      });
    }
    if (url.includes("/authserver/oauth/authorize")) {
      return new Response(null, { status: 302, headers: { Location: authorizeLocation } });
    }

    // ── sso.cqu.edu.cn (password re-login: GET login page, POST credentials) ──
    if (url.includes("sso.cqu.edu.cn/login")) {
      if (init?.method === "POST") {
        // 302 with a CAS ticket → password login proceeds to exchangeTicket.
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-pwlogin`,
            "Set-Cookie": "CASTGC=tgt-123; Path=/",
          },
        });
      }
      // GET login page → minimal HTML with execution + croypto (AES key is base64).
      const croypto = btoa(String.fromCharCode(...new Uint8Array(16)));
      const html =
        `<input id="login-page-flowkey" value="exec-1">` +
        `<input id="login-croypto" value="${croypto}">`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  }) as unknown as typeof globalThis.fetch;
}

async function readUser(db: ReturnType<typeof drizzle>, id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

describe("processTokenRefreshBatch (consumer) — AUTH accounts", () => {
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
  });

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare("DELETE FROM users").run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Insert a password account whose CQU refresh token is properly encrypted. */
  async function insertPasswordUser(studentId: string, tokenExpiresAt: string): Promise<string> {
    const id = await insertUser(db, { studentId, tokenExpiresAt });
    await db
      .update(users)
      .set({ refreshToken: await encrypt("cqu-rt-pw", TEST_KEY) })
      .where(eq(users.id, id));
    return id;
  }

  // ── Password account regression (with live fetch mock) ──────────────────
  it("password account: CQU refresh success → token updated, ack", async () => {
    globalThis.fetch = createAuthFetchMock();
    const id = await insertPasswordUser("20210100", STALE);
    const msg = mockMessage({ userId: id, studentId: "20210100" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(await decrypt(u.accessToken!, TEST_KEY)).toBe("cqu-at-refreshed");
    expect(u.authUserId).toBeNull();
  });

  it("password account: CQU TOKEN_EXPIRED → password re-login fallback", async () => {
    // invalid_grant on the CQU refresh → AuthError TOKEN_EXPIRED → password login()
    globalThis.fetch = createAuthFetchMock({
      cquRefreshStatus: 401,
      cquRefreshBody: { error: "invalid_grant" },
    });
    const id = await insertPasswordUser("20210101", STALE);
    const msg = mockMessage({ userId: id, studentId: "20210101" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    const u = await readUser(db, id);
    // login() → exchangeTicketForCquToken (code-exchange branch) → reminted tokens
    expect(await decrypt(u.accessToken!, TEST_KEY)).toBe("cqu-at-reminted");
  });

  // ── AUTH: CQU refresh success, auth not stale → no rotation ─────────────
  it("AUTH: CQU refresh success + auth not stale → CQU updated, no rotation, ack", async () => {
    globalThis.fetch = createAuthFetchMock();
    const id = await insertAuthUser(db, {
      studentId: "20210200",
      authUserId: "sub-200",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-old",
    });
    const msg = mockMessage({ userId: id, studentId: "20210200" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(await decrypt(u.accessToken!, TEST_KEY)).toBe("cqu-at-refreshed");
    // auth refresh untouched
    expect(await decrypt(u.authRefreshToken!, TEST_KEY)).toBe("auth-rt-old");
    expect(u.authRefreshIssuedAt).toBe(RECENT_AUTH);
  });

  // ── AUTH: D8 proactive rotation (rotated token stored) ──────────────────
  it("AUTH: CQU refresh success + auth stale → proactive rotation, new auth RT stored", async () => {
    globalThis.fetch = createAuthFetchMock();
    const id = await insertAuthUser(db, {
      studentId: "20210201",
      authUserId: "sub-201",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: OLD_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-old",
    });
    const msg = mockMessage({ userId: id, studentId: "20210201" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(await decrypt(u.accessToken!, TEST_KEY)).toBe("cqu-at-refreshed");
    // rotated auth refresh token stored, issued-at advanced
    expect(await decrypt(u.authRefreshToken!, TEST_KEY)).toBe("auth-rt-new");
    expect(u.authRefreshIssuedAt).not.toBe(OLD_AUTH);
    expect(Date.parse(u.authRefreshIssuedAt!)).toBeGreaterThan(Date.parse(OLD_AUTH));
  });

  it("AUTH: proactive rotation with empty rotated token → keeps existing auth RT", async () => {
    globalThis.fetch = createAuthFetchMock({
      // provider did NOT rotate (no refresh_token field)
      authTokenBody: { access_token: "auth-at-new", expires_in: 3600 },
    });
    const id = await insertAuthUser(db, {
      studentId: "20210202",
      authUserId: "sub-202",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: OLD_AUTH,
      authRefreshPlaintext: "auth-rt-keepme",
      cquRefreshPlaintext: "cqu-rt-old",
    });
    const msg = mockMessage({ userId: id, studentId: "20210202" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    const u = await readUser(db, id);
    // existing auth refresh token kept (NOT overwritten with "")
    expect(await decrypt(u.authRefreshToken!, TEST_KEY)).toBe("auth-rt-keepme");
    // issued-at still advanced (rotation attempt succeeded)
    expect(u.authRefreshIssuedAt).not.toBe(OLD_AUTH);
  });

  // ── AUTH: CQU TOKEN_EXPIRED → auth re-mint path ─────────────────────────
  it("AUTH: CQU TOKEN_EXPIRED → auth re-mint (refreshAuthToken → ticket → exchange) stores new CQU tokens", async () => {
    globalThis.fetch = createAuthFetchMock({
      cquRefreshStatus: 401,
      cquRefreshBody: { error: "invalid_grant" },
    });
    const id = await insertAuthUser(db, {
      studentId: "20210203",
      authUserId: "sub-203",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-dead",
    });
    const msg = mockMessage({ userId: id, studentId: "20210203" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(await decrypt(u.accessToken!, TEST_KEY)).toBe("cqu-at-reminted");
    expect(await decrypt(u.refreshToken!, TEST_KEY)).toBe("cqu-rt-reminted");
    // re-mint rotated the auth refresh token too
    expect(await decrypt(u.authRefreshToken!, TEST_KEY)).toBe("auth-rt-new");
    expect(u.authRefreshIssuedAt).not.toBe(RECENT_AUTH);
  });

  // ── Failure taxonomy ────────────────────────────────────────────────────
  it("AUTH: auth invalid_grant (re-mint, still stale) → user-permanent ack + loginError", async () => {
    globalThis.fetch = createAuthFetchMock({
      cquRefreshStatus: 401,
      cquRefreshBody: { error: "invalid_grant" }, // CQU dead → re-mint
      authTokenStatus: 400,
      authTokenBody: { error: "invalid_grant", error_description: "refresh token revoked" },
    });
    const id = await insertAuthUser(db, {
      studentId: "20210210",
      authUserId: "sub-210",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-dead",
      cquRefreshPlaintext: "cqu-rt-dead",
    });
    const msg = mockMessage({ userId: id, studentId: "20210210" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(u.loginError).toBeTruthy();
  });

  it("AUTH: auth invalid_client (re-mint) → operator-permanent ack + loginError", async () => {
    const errorSpy = vi.spyOn(console, "error");
    globalThis.fetch = createAuthFetchMock({
      cquRefreshStatus: 401,
      cquRefreshBody: { error: "invalid_grant" },
      authTokenStatus: 400,
      authTokenBody: { error: "invalid_client", error_description: "bad client" },
    });
    const id = await insertAuthUser(db, {
      studentId: "20210211",
      authUserId: "sub-211",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-dead",
    });
    const msg = mockMessage({ userId: id, studentId: "20210211" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(u.loginError).toBeTruthy();
    const operatorLog = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes("queue.token_refresh.operator_error"),
    );
    expect(operatorLog).toBeDefined();
  });

  it("AUTH: service-ticket 403 (scope_forbidden, re-mint) → operator-permanent ack", async () => {
    const errorSpy = vi.spyOn(console, "error");
    globalThis.fetch = createAuthFetchMock({
      cquRefreshStatus: 401,
      cquRefreshBody: { error: "invalid_grant" },
      serviceTicketStatus: 403,
    });
    const id = await insertAuthUser(db, {
      studentId: "20210212",
      authUserId: "sub-212",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-dead",
    });
    const msg = mockMessage({ userId: id, studentId: "20210212" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const operatorLog = errorSpy.mock.calls.find((c) =>
      String(c[0]).includes("queue.token_refresh.operator_error"),
    );
    expect(operatorLog).toBeDefined();
  });

  it("AUTH: auth 5xx (transient, re-mint) → retry", async () => {
    globalThis.fetch = createAuthFetchMock({
      cquRefreshStatus: 401,
      cquRefreshBody: { error: "invalid_grant" },
      authTokenStatus: 503,
      authTokenBody: { error: "server_error" },
    });
    const id = await insertAuthUser(db, {
      studentId: "20210213",
      authUserId: "sub-213",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-dead",
    });
    const msg = mockMessage({ userId: id, studentId: "20210213" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  // ── Benign race: invalid_grant but row already rotated ──────────────────
  it("AUTH: re-mint invalid_grant, reread shows token already advanced → benign ack", async () => {
    // The consumer reads the row, attempts re-mint (CQU dead), auth returns
    // invalid_grant; the benign-race reread must find the token changed.
    // We arrange this by having the auth token endpoint mutate the DB row to a
    // new auth refresh token right before returning invalid_grant, emulating a
    // concurrent delivery that rotated between our SELECT and our token call.
    const id = await insertAuthUser(db, {
      studentId: "20210215",
      authUserId: "sub-215",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-dead",
    });

    globalThis.fetch = vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (body: object, status: number) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/authserver/oauth/token")) {
        const body = init?.body?.toString() ?? "";
        if (body.includes("grant_type=refresh_token")) {
          return json({ error: "invalid_grant" }, 401); // CQU dead
        }
        return json({ access_token: "x" }, 200);
      }
      if (url.startsWith(`${AUTH_BASE}/api/auth/oauth2/token`)) {
        // A concurrent delivery already rotated → row's auth token changed.
        await db
          .update(users)
          .set({ authRefreshToken: await encrypt("auth-rt-from-concurrent", TEST_KEY), authRefreshIssuedAt: new Date().toISOString() })
          .where(eq(users.id, id));
        return json({ error: "invalid_grant", error_description: "revoked" }, 400);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    }) as unknown as typeof globalThis.fetch;

    const msg = mockMessage({ userId: id, studentId: "20210215" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    // benign race → loginError NOT set
    expect(u.loginError).toBeNull();
  });

  // ── Early-exit gate ──────────────────────────────────────────────────────
  it("AUTH: CQU fresh + auth not stale → early ack (no fetch)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const id = await insertAuthUser(db, {
      studentId: "20210220",
      authUserId: "sub-220",
      tokenExpiresAt: FRESH,
      authRefreshIssuedAt: RECENT_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-old",
    });
    const msg = mockMessage({ userId: id, studentId: "20210220" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AUTH: CQU fresh + auth stale → auth-only rotation (CQU token untouched)", async () => {
    globalThis.fetch = createAuthFetchMock();
    const id = await insertAuthUser(db, {
      studentId: "20210221",
      authUserId: "sub-221",
      tokenExpiresAt: FRESH,
      authRefreshIssuedAt: OLD_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-old",
    });
    const before = await readUser(db, id);
    const msg = mockMessage({ userId: id, studentId: "20210221" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    const u = await readUser(db, id);
    // CQU access token untouched
    expect(u.accessToken).toBe(before.accessToken);
    expect(u.tokenExpiresAt).toBe(FRESH);
    // auth refresh rotated
    expect(await decrypt(u.authRefreshToken!, TEST_KEY)).toBe("auth-rt-new");
    expect(u.authRefreshIssuedAt).not.toBe(OLD_AUTH);
  });

  it("AUTH: auth-only rotation invalid_grant but reread shows already rotated → benign ack", async () => {
    const id = await insertAuthUser(db, {
      studentId: "20210222",
      authUserId: "sub-222",
      tokenExpiresAt: FRESH, // CQU fresh → auth-only rotation path
      authRefreshIssuedAt: OLD_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-old",
    });

    // The auth token endpoint mutates the row (concurrent rotation) then returns
    // invalid_grant; the benign-race reread sees a different stored token.
    globalThis.fetch = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(`${AUTH_BASE}/api/auth/oauth2/token`)) {
        await db
          .update(users)
          .set({ authRefreshToken: await encrypt("auth-rt-concurrent", TEST_KEY), authRefreshIssuedAt: new Date().toISOString() })
          .where(eq(users.id, id));
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    }) as unknown as typeof globalThis.fetch;

    const msg = mockMessage({ userId: id, studentId: "20210222" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    expect(u.loginError).toBeNull();
  });

  // ── Proactive rotation transient failure → does not fail msg or roll back ──
  it("AUTH: CQU refresh success + proactive rotation transient failure → ack, CQU token persisted", async () => {
    globalThis.fetch = createAuthFetchMock({
      authTokenStatus: 503,
      authTokenBody: { error: "server_error" },
    });
    const id = await insertAuthUser(db, {
      studentId: "20210230",
      authUserId: "sub-230",
      tokenExpiresAt: STALE,
      authRefreshIssuedAt: OLD_AUTH,
      authRefreshPlaintext: "auth-rt-old",
      cquRefreshPlaintext: "cqu-rt-old",
    });
    const msg = mockMessage({ userId: id, studentId: "20210230" });

    await processTokenRefreshBatch(mockBatch([msg]), authEnv());

    // Message acked (NOT retried) — CQU token is valid this round.
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    const u = await readUser(db, id);
    // CQU refresh persisted
    expect(await decrypt(u.accessToken!, TEST_KEY)).toBe("cqu-at-refreshed");
    // auth refresh NOT rolled back (still the old token, issued-at unchanged)
    expect(await decrypt(u.authRefreshToken!, TEST_KEY)).toBe("auth-rt-old");
    expect(u.authRefreshIssuedAt).toBe(OLD_AUTH);
  });
});
