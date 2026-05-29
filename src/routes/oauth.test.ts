import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import oauthApp from "./oauth";
import { openTx } from "../services/oauth-tx";
import { AUTH_BASE, OAUTH_SCOPE } from "../services/oauth-constants";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";

// 32-byte (256-bit) key, base64-encoded — matches AES-GCM key length used by crypto.ts
const OAUTH_STATE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
// Independent 32-byte key for at-rest token encryption.
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));

const mockEnv = {
  OAUTH_STATE_KEY,
  AUTH_OAUTH_CLIENT_ID: "test-client-id",
  UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
} as any;

// The sub-app serves "/login"; mounting at /api/v1/auth/oauth happens in the parent app.
// We request the sub-app's own path but vary the host (origin is resolved from the host).
function login(host: string, env = mockEnv) {
  return oauthApp.request(`${host}/login`, { method: "GET" }, env);
}

/** Pull the oauth_tx cookie value out of a Set-Cookie header. */
function cookieValue(setCookie: string): string {
  const match = /oauth_tx=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`no oauth_tx in Set-Cookie: ${setCookie}`);
  return decodeURIComponent(match[1]);
}

describe("GET /login", () => {
  it("redirects to the authorize endpoint with PKCE + state for the prod host", async () => {
    const res = await login("https://schedule.cqu.moe");

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toBeTruthy();
    expect(location.startsWith(`${AUTH_BASE}/api/auth/oauth2/authorize`)).toBe(true);

    const url = new URL(location);
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://schedule.cqu.moe/api/v1/auth/oauth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    // redirect_uri must be URL-encoded in the raw Location string
    expect(location).toContain(
      "redirect_uri=https%3A%2F%2Fschedule.cqu.moe%2Fapi%2Fv1%2Fauth%2Foauth%2Fcallback",
    );
    // scope spaces must be encoded (URLSearchParams uses '+')
    expect(location).toContain("scope=openid+offline_access+cqu%3Aticket%3Ajwxt");
  });

  it("sets a hardened oauth_tx cookie with Secure on https", async () => {
    const res = await login("https://schedule.cqu.moe");
    const setCookie = res.headers.get("Set-Cookie")!;

    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("oauth_tx=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/v1/auth/oauth");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("Secure");
  });

  it("uses the beta origin for redirect_uri and sealed cookie on the beta host", async () => {
    const res = await login("https://schedule-beta.cqu.moe");

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(
      "https://schedule-beta.cqu.moe/api/v1/auth/oauth/callback",
    );

    const sealed = cookieValue(res.headers.get("Set-Cookie")!);
    const tx = await openTx(sealed, OAUTH_STATE_KEY, Date.now());
    expect(tx).not.toBeNull();
    expect(tx!.origin).toBe("https://schedule-beta.cqu.moe");
  });

  it("omits Secure on the http localhost dev origin", async () => {
    const res = await login("http://localhost:8787");

    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("oauth_tx=");
    expect(setCookie).not.toContain("Secure");
  });

  it("returns 400 (no cookie, no redirect) for an unknown host", async () => {
    const res = await login("https://evil.example.com");

    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Location")).toBeNull();
    const body = await res.json();
    expect(body.detail.error.code).toBe("BAD_REQUEST");
  });

  it("redirects #error=internal (not a 500) when OAUTH_STATE_KEY is missing/invalid", async () => {
    // No OAUTH_STATE_KEY → sealTx → encrypt throws after the origin is resolved.
    // The /login body must degrade to a #error=internal redirect, never a raw 500.
    const badEnv = {
      AUTH_OAUTH_CLIENT_ID: "test-client-id",
      UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    } as any;
    const res = await login("https://schedule.cqu.moe", badEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://schedule.cqu.moe/auth/callback#error=internal",
    );
  });

  it("round-trips state/origin through the sealed cookie and matches the Location state", async () => {
    const res = await login("https://schedule.cqu.moe");

    const locationState = new URL(res.headers.get("Location")!).searchParams.get("state");
    const sealed = cookieValue(res.headers.get("Set-Cookie")!);
    const tx = await openTx(sealed, OAUTH_STATE_KEY, Date.now());

    expect(tx).not.toBeNull();
    expect(tx!.origin).toBe("https://schedule.cqu.moe");
    expect(tx!.state).toBe(locationState);
    expect(tx!.verifier).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /callback
// ─────────────────────────────────────────────────────────────────────────────

const PROD_ORIGIN = "https://schedule.cqu.moe";

/**
 * Build the env used by the callback. Backed by the real cloudflare:test D1
 * (env.DB) for genuine onConflictDoNothing / returning / read-after-conflict
 * fidelity, plus a KV stub for the background sync's session cache.
 */
function callbackEnv(): Env {
  return {
    ...env,
    OAUTH_STATE_KEY,
    ENCRYPTION_KEY,
    AUTH_OAUTH_CLIENT_ID: "test-client-id",
    AUTH_OAUTH_CLIENT_SECRET: "test-secret",
    UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env;
}

/**
 * Minimal ExecutionContext capturing waitUntil promises so we can await them.
 * `scheduled` exposes how many times waitUntil fired (the callback only schedules
 * syncNewUserSubscriptions on the insert-winner path, so its length = sync count).
 */
function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(Promise.resolve(p).catch(() => {}));
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    settle: () => Promise.all(scheduled),
  };
}

interface CallbackFetchOverrides {
  // auth.cqu.moe/.../token (exchangeCode)
  tokenStatus?: number;
  tokenBody?: object;
  // auth.cqu.moe/.../userinfo
  userinfoStatus?: number;
  userinfoBody?: object;
  // auth.cqu.moe/api/cqu/status
  cquStatusStatus?: number;
  cquStatusBody?: object;
  // auth.cqu.moe/api/cqu/service-ticket
  serviceTicketStatus?: number;
  serviceTicketBody?: object;
  // CAS dance (exchangeTicketForCquToken)
  casCookie?: string;
  authorizeLocation?: string;
  cquTokenBody?: object;
}

/**
 * URL-routing fetch mock covering the whole callback dance:
 *   auth.cqu.moe: token, userinfo, cqu/status, cqu/service-ticket
 *   my.cqu.edu.cn (CAS): validate (Set-Cookie SESSION), authorize (302 code), token
 * Distinct hosts/paths disambiguate every call.
 */
function createCallbackFetchMock(o: CallbackFetchOverrides = {}) {
  const {
    tokenStatus = 200,
    tokenBody = { access_token: "auth-at", refresh_token: "auth-rt", expires_in: 3600 },
    userinfoStatus = 200,
    userinfoBody = { sub: "auth-sub-123" },
    cquStatusStatus = 200,
    cquStatusBody = { status: "active", studentId: "20210099" },
    serviceTicketStatus = 200,
    serviceTicketBody = { ticket: "ST-callback" },
    casCookie = "SESSION=sess-cb; Path=/",
    authorizeLocation = "https://my.cqu.edu.cn/workspace/token-index?code=CQUCODE&state=",
    cquTokenBody = { access_token: "cqu-at", refresh_token: "cqu-rt", expires_in: 14400 },
  } = o;

  return vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: object, status: number) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );

    // ── auth.cqu.moe ──
    if (url.startsWith(`${AUTH_BASE}/api/auth/oauth2/token`)) {
      return json(tokenBody, tokenStatus);
    }
    if (url.startsWith(`${AUTH_BASE}/api/auth/oauth2/userinfo`)) {
      return json(userinfoBody, userinfoStatus);
    }
    if (url.startsWith(`${AUTH_BASE}/api/cqu/status`)) {
      return json(cquStatusBody, cquStatusStatus);
    }
    if (url.startsWith(`${AUTH_BASE}/api/cqu/service-ticket`)) {
      return json(serviceTicketBody, serviceTicketStatus);
    }

    // ── my.cqu.edu.cn CAS dance ──
    if (url.includes("/authserver/authentication/cas")) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { "Set-Cookie": casCookie, Location: "/workspace/cas" },
        }),
      );
    }
    if (url.includes("/authserver/oauth/authorize")) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { Location: authorizeLocation } }),
      );
    }
    if (url.includes("/authserver/oauth/token")) {
      return json(cquTokenBody, 200);
    }

    // ── CQU schedule API (background sync) — fail fast; sync swallows it ──
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  });
}

/** Run /login → grab the real Set-Cookie + state, then drive /callback with them. */
async function startTx(host = PROD_ORIGIN) {
  const env_ = callbackEnv();
  const loginRes = await oauthApp.request(`${host}/login`, { method: "GET" }, env_);
  const setCookie = loginRes.headers.get("Set-Cookie")!;
  const sealed = cookieValue(setCookie);
  const state = new URL(loginRes.headers.get("Location")!).searchParams.get("state")!;
  // The raw Cookie header value sent back by the browser is the exact sealed base64.
  const rawCookie = /oauth_tx=([^;]+)/.exec(setCookie)![1];
  return { env_, sealed, state, rawCookie };
}

function callback(
  host: string,
  query: Record<string, string>,
  cookie: string | null,
  env_: Env,
  ctx?: ExecutionContext,
) {
  const qs = new URLSearchParams(query).toString();
  const headers: Record<string, string> = {};
  if (cookie !== null) headers["Cookie"] = `oauth_tx=${cookie}`;
  return oauthApp.request(
    `${host}/callback?${qs}`,
    { method: "GET", headers },
    env_,
    ctx,
  );
}

describe("GET /callback", () => {
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

  // ── Happy path + cookie round-trip ──────────────────────────────────
  it("completes the happy path: cookie round-trip → token fragment, new user + 3 subs + sync", async () => {
    globalThis.fetch = createCallbackFetchMock();
    const { env_, state, rawCookie } = await startTx();
    const { ctx, settle } = makeExecutionCtx();

    // Feed the EXACT raw cookie value from /login's Set-Cookie into /callback.
    const res = await callback(PROD_ORIGIN, { code: "AUTHCODE", state }, rawCookie, env_, ctx);

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location.startsWith(`${PROD_ORIGIN}/auth/callback#token=`)).toBe(true);
    const token = location.split("#token=")[1];
    expect(token).toBeTruthy();

    // The tx cookie is cleared.
    expect(res.headers.get("Set-Cookie")).toContain("oauth_tx=;");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");

    // New user row inserted with the fragment token + sentinel password.
    const [user] = await db.select().from(users).where(eq(users.authUserId, "auth-sub-123"));
    expect(user).toBeTruthy();
    expect(user.calendarToken).toBe(token);
    expect(user.studentId).toBe("20210099");
    expect(user.encryptedPassword).toBe("");
    expect(user.accessToken).toBeTruthy();
    expect(user.accessToken).not.toBe("cqu-at"); // encrypted at rest
    expect(user.authRefreshToken).toBeTruthy();
    expect(user.authRefreshIssuedAt).toBeTruthy();

    // 3 personal subscriptions created.
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
    expect(subs).toHaveLength(3);
    expect(subs.every((s) => s.isPersonal)).toBe(true);
    expect(subs.every((s) => s.sourceId === "20210099")).toBe(true);
    expect(new Set(subs.map((s) => s.sourceType))).toEqual(
      new Set(["personal_all", "personal_courses", "personal_exams"]),
    );

    // Background sync was scheduled (it fetches the CQU schedule API, which our
    // mock rejects — syncNewUserSubscriptions swallows that internally).
    await settle();
  });

  // ── Step 0: provider error / missing params ─────────────────────────
  it("redirects #error=access_denied when the provider returns ?error", async () => {
    globalThis.fetch = createCallbackFetchMock();
    const { env_ } = await startTx();
    const res = await callback(PROD_ORIGIN, { error: "access_denied", state: "x" }, "junk", env_);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=access_denied`);
  });

  it("redirects #error=oauth_missing_code when code is absent", async () => {
    const { env_, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { state: "x" }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(
      `${PROD_ORIGIN}/auth/callback#error=oauth_missing_code`,
    );
  });

  it("redirects #error=oauth_missing_code when state is absent", async () => {
    const { env_, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc" }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(
      `${PROD_ORIGIN}/auth/callback#error=oauth_missing_code`,
    );
  });

  // ── Step 1/2: tx cookie + state validation ──────────────────────────
  it("redirects #error=oauth_state when the cookie is missing", async () => {
    const { env_, state } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, null, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_state`);
  });

  it("redirects #error=oauth_state when the cookie is tampered", async () => {
    const { env_, state, rawCookie } = await startTx();
    // Flip a character in the sealed base64 → decrypt fails.
    const tampered = rawCookie.slice(0, -2) + (rawCookie.slice(-2) === "AA" ? "BB" : "AA");
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, tampered, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_state`);
  });

  it("redirects #error=oauth_state when the state does not match (timing-safe compare)", async () => {
    const { env_, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state: "not-the-state" }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_state`);
  });

  it("redirects #error=oauth_state when the tx origin does not match the request origin", async () => {
    // Cookie sealed for the beta origin, replayed against the prod host.
    const { rawCookie, state } = await startTx("https://schedule-beta.cqu.moe");
    const env_ = callbackEnv();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_state`);
  });

  // ── Step 4: token exchange failure ──────────────────────────────────
  it("redirects #error=oauth_token when exchangeCode fails", async () => {
    globalThis.fetch = createCallbackFetchMock({
      tokenStatus: 400,
      tokenBody: { error: "invalid_grant" },
    });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_token`);
  });

  it("redirects #error=oauth_token when userinfo fails", async () => {
    globalThis.fetch = createCallbackFetchMock({ userinfoStatus: 401 });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_token`);
  });

  it("redirects #error=oauth_token and creates NO user when the auth refresh_token is empty", async () => {
    // exchangeCode succeeds but returns an empty refresh_token (postToken defaults a
    // missing refresh_token to ""). Such an account cannot be kept alive by the D8
    // rotation, so the callback must abort before creating any row.
    globalThis.fetch = createCallbackFetchMock({
      tokenBody: { access_token: "auth-at", refresh_token: "", expires_in: 3600 },
    });
    const { env_, state, rawCookie } = await startTx();
    const { ctx } = makeExecutionCtx();
    const res = await callback(PROD_ORIGIN, { code: "AUTHCODE", state }, rawCookie, env_, ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=oauth_token`);

    // No user row was created.
    const rows = await db.select().from(users).where(eq(users.authUserId, "auth-sub-123"));
    expect(rows).toHaveLength(0);
  });

  // ── Step 6: CQU status ──────────────────────────────────────────────
  it("redirects #error=cqu_unbound when status is unbound", async () => {
    globalThis.fetch = createCallbackFetchMock({ cquStatusBody: { status: "unbound" } });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=cqu_unbound`);
  });

  it("redirects #error=cqu_unbound when active but studentId is missing", async () => {
    globalThis.fetch = createCallbackFetchMock({ cquStatusBody: { status: "active" } });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=cqu_unbound`);
  });

  it("redirects #error=cqu_ticket when status is expired", async () => {
    globalThis.fetch = createCallbackFetchMock({
      cquStatusBody: { status: "expired", studentId: "20210099" },
    });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=cqu_ticket`);
  });

  it("redirects #error=cqu_ticket when the service-ticket endpoint 403s", async () => {
    globalThis.fetch = createCallbackFetchMock({ serviceTicketStatus: 403 });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=cqu_ticket`);
  });

  // ── Step 8: CQU bearer mint ─────────────────────────────────────────
  it("redirects #error=cqu_login when exchangeTicketForCquToken fails", async () => {
    // CAS validate returns no SESSION cookie → AuthError.
    globalThis.fetch = createCallbackFetchMock({ casCookie: "OTHER=x; Path=/" });
    const { env_, state, rawCookie } = await startTx();
    const res = await callback(PROD_ORIGIN, { code: "abc", state }, rawCookie, env_);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=cqu_login`);
  });

  // ── internal: unexpected throw (never a raw 500) ────────────────────
  it("redirects #error=internal on an unexpected throw (not a 500)", async () => {
    globalThis.fetch = createCallbackFetchMock();
    const { state, rawCookie } = await startTx();
    // Break the DB so the upsert throws an unexpected (non-Auth) error.
    const env_ = { ...callbackEnv(), DB: undefined } as unknown as Env;
    const { ctx } = makeExecutionCtx();
    const res = await callback(PROD_ORIGIN, { code: "AUTHCODE", state }, rawCookie, env_, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${PROD_ORIGIN}/auth/callback#error=internal`);
  });

  it("returns a 400 plain response (no redirect) for an unknown host", async () => {
    globalThis.fetch = createCallbackFetchMock();
    const env_ = callbackEnv();
    const res = await callback("https://evil.example.com", { code: "x", state: "y" }, "junk", env_);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  // ── existing-auth-account path (conflict → read-after-conflict → update) ─
  it("updates tokens + source_id on the existing account without creating new subs", async () => {
    globalThis.fetch = createCallbackFetchMock({
      cquStatusBody: { status: "active", studentId: "20219999" },
    });

    // Pre-existing auth account bound to the same sub, but an older studentId.
    const existingId = crypto.randomUUID();
    const existingToken = crypto.randomUUID() + crypto.randomUUID();
    const old = new Date(Date.now() - 86_400_000).toISOString();
    await db.insert(users).values({
      id: existingId,
      authUserId: "auth-sub-123",
      studentId: "20210000",
      encryptedPassword: "",
      accessToken: "stale-access",
      refreshToken: "stale-refresh",
      tokenExpiresAt: old,
      authRefreshToken: "stale-auth-refresh",
      authRefreshIssuedAt: old,
      calendarToken: existingToken,
      createdAt: old,
      updatedAt: old,
    });
    // One pre-existing personal subscription with the old studentId as source_id.
    const subId = crypto.randomUUID();
    await db.insert(subscriptions).values({
      id: subId,
      userId: existingId,
      sourceType: "personal_all",
      sourceId: "20210000",
      sourceName: "全部课表",
      calendarToken: crypto.randomUUID() + crypto.randomUUID(),
      isPersonal: true,
      createdAt: old,
      updatedAt: old,
    });

    const { env_, state, rawCookie } = await startTx();
    const { ctx, settle } = makeExecutionCtx();
    const res = await callback(PROD_ORIGIN, { code: "AUTHCODE", state }, rawCookie, env_, ctx);

    // Redirect uses the EXISTING calendar token (not a freshly minted one).
    expect(res.headers.get("Location")).toBe(
      `${PROD_ORIGIN}/auth/callback#token=${existingToken}`,
    );

    // Tokens refreshed + studentId rebound on the same row.
    const [user] = await db.select().from(users).where(eq(users.id, existingId));
    expect(user.studentId).toBe("20219999");
    expect(user.accessToken).not.toBe("stale-access");
    expect(user.authRefreshToken).not.toBe("stale-auth-refresh");
    expect(user.lastLoginAt).not.toBe(old);

    // No new subscriptions; the existing personal sub's source_id is rebound.
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, existingId));
    expect(subs).toHaveLength(1);
    expect(subs[0].sourceId).toBe("20219999");
    expect(subs[0].id).toBe(subId);

    await settle();
  });

  // ── Concurrency: two callbacks for the SAME sub → exactly-once end state ─
  // Design §11 / Task 7: two concurrent callbacks for the same `sub` must produce
  // exactly one user row, exactly 3 personal subscriptions, and at-most-once sync.
  //
  // Both transactions resolve the SAME mocked userinfo `sub` + active CQU status,
  // so they race on the `users_auth_user_id_unique` index. onConflictDoNothing means
  // only the winning insert returns a row (→ creates the 3 subs + schedules sync);
  // the loser takes the read-after-conflict path (no new subs, reuses the calendar
  // token). The `uq_personal_user_source` partial unique index further guarantees
  // at most 3 personal subs even if both somehow tried to insert.
  //
  // Note: under cloudflare:test, D1's single-writer model serializes the two writes,
  // so the exactly-once outcome is guaranteed by the DB even when we fire both via
  // Promise.all. We assert the end state — the property that actually matters.
  it("two concurrent callbacks for the same sub → 1 user, 3 subs, at-most-once sync", async () => {
    globalThis.fetch = createCallbackFetchMock();

    // Two independent valid OAuth transactions, each with its own sealed cookie.
    const tx1 = await startTx();
    const tx2 = await startTx();
    const ec1 = makeExecutionCtx();
    const ec2 = makeExecutionCtx();

    const [res1, res2] = await Promise.all([
      callback(PROD_ORIGIN, { code: "AUTHCODE", state: tx1.state }, tx1.rawCookie, tx1.env_, ec1.ctx),
      callback(PROD_ORIGIN, { code: "AUTHCODE", state: tx2.state }, tx2.rawCookie, tx2.env_, ec2.ctx),
    ]);

    // Both succeed (302 to a #token= fragment); the conflict one reuses the same token.
    expect(res1.status).toBe(302);
    expect(res2.status).toBe(302);
    const loc1 = res1.headers.get("Location")!;
    const loc2 = res2.headers.get("Location")!;
    expect(loc1.startsWith(`${PROD_ORIGIN}/auth/callback#token=`)).toBe(true);
    expect(loc2.startsWith(`${PROD_ORIGIN}/auth/callback#token=`)).toBe(true);
    expect(loc1.split("#token=")[1]).toBe(loc2.split("#token=")[1]);

    // Exactly ONE users row for that auth_user_id.
    const rows = await db.select().from(users).where(eq(users.authUserId, "auth-sub-123"));
    expect(rows).toHaveLength(1);

    // Exactly 3 personal subscriptions for that user.
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, rows[0].id));
    expect(subs).toHaveLength(3);
    expect(new Set(subs.map((s) => s.sourceType))).toEqual(
      new Set(["personal_all", "personal_courses", "personal_exams"]),
    );

    // The redirect token matches the single stored calendar token.
    expect(rows[0].calendarToken).toBe(loc1.split("#token=")[1]);

    // Background sync (syncNewUserSubscriptions, via waitUntil) was scheduled at most
    // once — only the insert winner reaches the sync-scheduling branch.
    expect(ec1.scheduled.length + ec2.scheduled.length).toBeLessThanOrEqual(1);

    await Promise.all([ec1.settle(), ec2.settle()]);
  });
});
