import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { rateLimit } from "../middleware/rate-limit";
import { errorResponse } from "../utils/error";
import {
  AUTH_BASE,
  OAUTH_SCOPE,
  OAUTH_TX_COOKIE,
  OAUTH_TX_TTL_MS,
  OAUTH_COOKIE_PATH,
  resolveOrigin,
} from "../services/oauth-constants";
import { generatePkce, generateState, sealTx, openTx } from "../services/oauth-tx";
import {
  exchangeCode,
  getUserInfo,
  getCquStatus,
  getServiceTicket,
  AuthOAuthError,
} from "../services/auth-oauth-client";
import { exchangeTicketForCquToken, AuthError } from "../services/auth";
import { encrypt } from "../services/crypto";
import { users, subscriptions } from "../db/schema";
import { generateToken } from "../utils/token";
import { syncNewUserSubscriptions } from "./users";

const app = new Hono<{ Bindings: Env }>();

/** Timing-safe equality over UTF-8 encoded strings (guards unequal length first). */
function timingSafeStrEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// GET /api/v1/auth/oauth/login — start Authorization Code + PKCE against auth.cqu.moe
app.get("/login", rateLimit("UNAUTH_LIMITER"), async (c) => {
  // resolveOrigin calls new URL(...) which throws on a malformed URL; never 500.
  let origin: string | null;
  try {
    origin = resolveOrigin(c.req.url);
  } catch {
    origin = null;
  }
  if (!origin) {
    return errorResponse("BAD_REQUEST", "unsupported host", 400);
  }

  const { verifier, challenge } = await generatePkce();
  const state = generateState();

  const sealed = await sealTx(
    { state, verifier, origin },
    c.env.OAUTH_STATE_KEY,
    Date.now() + OAUTH_TX_TTL_MS,
  );

  // Secure only on https — the browser drops a Secure cookie over http://localhost.
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${OAUTH_TX_COOKIE}=${sealed}; HttpOnly${secure}; SameSite=Lax; Path=${OAUTH_COOKIE_PATH}; Max-Age=600`,
  );

  const params = new URLSearchParams({
    client_id: c.env.AUTH_OAUTH_CLIENT_ID,
    redirect_uri: `${origin}/api/v1/auth/oauth/callback`,
    response_type: "code",
    scope: OAUTH_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return c.redirect(`${AUTH_BASE}/api/auth/oauth2/authorize?${params.toString()}`, 302);
});

// GET /api/v1/auth/oauth/callback — complete Authorization Code + PKCE, mint a CQU
// bearer token, upsert the AUTH account, and hand the calendar_token to the SPA via
// a URL fragment. The whole body is wrapped so it NEVER returns a raw 500: any
// unexpected throw becomes `#error=internal` (the global JSON 500 handler would
// break the SPA callback). Every failure maps to a `#error=<code>` fragment.
app.get("/callback", rateLimit("UNAUTH_LIMITER"), async (c) => {
  // resolveOrigin → new URL(...) can throw on a malformed URL. If we can't resolve a
  // safe redirect target we cannot build a `#error=` redirect either, so fall back to
  // a 400 plain response.
  let origin: string | null;
  try {
    origin = resolveOrigin(c.req.url);
  } catch {
    origin = null;
  }
  if (!origin) {
    return c.text("unsupported host", 400);
  }
  const safeOrigin = origin;

  const redirectErr = (code: string): Response =>
    c.redirect(`${safeOrigin}/auth/callback#error=${code}`, 302);

  // Clear the tx cookie regardless of outcome. Secure only on https.
  const clearCookie = (): void => {
    const secure = safeOrigin.startsWith("https://") ? "; Secure" : "";
    c.header(
      "Set-Cookie",
      `${OAUTH_TX_COOKIE}=; HttpOnly${secure}; SameSite=Lax; Path=${OAUTH_COOKIE_PATH}; Max-Age=0`,
    );
  };

  try {
    // ── Step 0: provider error / missing params ──────────────────────
    if (c.req.query("error")) {
      return redirectErr("access_denied");
    }
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    if (!code || !stateParam) {
      return redirectErr("oauth_missing_code");
    }

    // ── Step 1: read + validate the tx cookie ────────────────────────
    // Read RAW: the sealed value is standard base64 (may contain + / =); Hono's
    // getCookie only URL-decodes when the value contains "%", which base64 never
    // does — so the value survives the Set-Cookie→Cookie round-trip intact.
    const sealed = getCookie(c, OAUTH_TX_COOKIE);
    if (!sealed) {
      return redirectErr("oauth_state");
    }
    const tx = await openTx(sealed, c.env.OAUTH_STATE_KEY, Date.now());
    if (!tx || tx.origin !== safeOrigin) {
      return redirectErr("oauth_state");
    }

    // ── Step 2: CSRF state check (timing-safe) ───────────────────────
    if (!timingSafeStrEqual(tx.state, stateParam)) {
      return redirectErr("oauth_state");
    }

    // ── Step 3: clear the cookie (from here on, regardless of outcome) ─
    clearCookie();

    // ── Step 4: exchange the authorization code for auth tokens ──────
    let tokens;
    try {
      tokens = await exchangeCode(c.env, {
        code,
        redirectUri: `${safeOrigin}/api/v1/auth/oauth/callback`,
        codeVerifier: tx.verifier,
      });
    } catch (e) {
      if (e instanceof AuthOAuthError) return redirectErr("oauth_token");
      throw e;
    }

    // ── Step 5: userinfo → sub ───────────────────────────────────────
    let sub: string;
    try {
      ({ sub } = await getUserInfo(tokens.accessToken));
    } catch (e) {
      if (e instanceof AuthOAuthError) return redirectErr("oauth_token");
      throw e;
    }

    // ── Step 6: CQU binding status ───────────────────────────────────
    let status, studentId;
    try {
      ({ status, studentId } = await getCquStatus(tokens.accessToken));
    } catch (e) {
      if (e instanceof AuthOAuthError) return redirectErr("cqu_ticket");
      throw e;
    }
    if (status === "unbound" || !studentId) {
      return redirectErr("cqu_unbound");
    }
    if (status !== "active") {
      // "expired" | "error"
      return redirectErr("cqu_ticket");
    }

    // ── Step 7: CAS service ticket ───────────────────────────────────
    let ticket: string;
    try {
      ticket = await getServiceTicket(tokens.accessToken);
    } catch (e) {
      if (e instanceof AuthOAuthError) return redirectErr("cqu_ticket");
      throw e;
    }

    // ── Step 8: mint CQU bearer (no cookie arg — OAuth path has no CASTGC) ─
    let cquTokens;
    try {
      cquTokens = await exchangeTicketForCquToken(ticket);
    } catch (e) {
      if (e instanceof AuthError) return redirectErr("cqu_login");
      throw e;
    }

    // ── Step 9: upsert the AUTH account (idempotent) ─────────────────
    const db = drizzle(c.env.DB);
    const [encAccess, encRefresh, encAuthRefresh] = await Promise.all([
      encrypt(cquTokens.accessToken, c.env.ENCRYPTION_KEY),
      encrypt(cquTokens.refreshToken, c.env.ENCRYPTION_KEY),
      encrypt(tokens.refreshToken, c.env.ENCRYPTION_KEY),
    ]);
    const now = new Date().toISOString();

    const inserted = await db
      .insert(users)
      .values({
        authUserId: sub,
        studentId,
        encryptedPassword: "", // D7 sentinel for auth accounts (NOT null)
        accessToken: encAccess,
        refreshToken: encRefresh,
        tokenExpiresAt: cquTokens.expiresAt,
        authRefreshToken: encAuthRefresh,
        authRefreshIssuedAt: now,
        calendarToken: generateToken(),
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: users.authUserId })
      .returning({ id: users.id, calendarToken: users.calendarToken });

    let calendarToken: string;

    if (inserted.length > 0) {
      // New auth account — create the 3 personal subscriptions and kick off sync.
      const { id, calendarToken: ct } = inserted[0];
      calendarToken = ct;

      const personalSubValues = ([
        { sourceType: "personal_all" as const, sourceName: "全部课表" },
        { sourceType: "personal_courses" as const, sourceName: "仅课程" },
        { sourceType: "personal_exams" as const, sourceName: "仅考试" },
      ]).map(({ sourceType, sourceName }) => ({
        userId: id,
        sourceType,
        sourceId: studentId,
        sourceName,
        calendarToken: generateToken(),
        isPersonal: true,
        createdAt: now,
        updatedAt: now,
      }));

      const newSubs = await db
        .insert(subscriptions)
        .values(personalSubValues)
        .returning({ id: subscriptions.id, sourceType: subscriptions.sourceType });

      c.executionCtx.waitUntil(
        syncNewUserSubscriptions(c.env, id, studentId, cquTokens.accessToken, newSubs),
      );
    } else {
      // Existing auth account (conflict) — read-after-conflict, then refresh tokens.
      const [existing] = await db
        .select({ id: users.id, calendarToken: users.calendarToken })
        .from(users)
        .where(eq(users.authUserId, sub))
        .limit(1);

      if (!existing) {
        // Extremely unlikely (conflict but row vanished); treat as internal.
        return redirectErr("internal");
      }
      calendarToken = existing.calendarToken;

      await db
        .update(users)
        .set({
          accessToken: encAccess,
          refreshToken: encRefresh,
          tokenExpiresAt: cquTokens.expiresAt,
          authRefreshToken: encAuthRefresh,
          authRefreshIssuedAt: now,
          studentId,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, existing.id));

      // D9 rebind: keep the personal subscriptions' source_id in sync with studentId.
      await db
        .update(subscriptions)
        .set({ sourceId: studentId, updatedAt: now })
        .where(and(eq(subscriptions.userId, existing.id), eq(subscriptions.isPersonal, true)));
    }

    // ── Step 10: hand the calendar_token to the SPA ──────────────────
    return c.redirect(`${safeOrigin}/auth/callback#token=${calendarToken}`, 302);
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "auth.oauth.callback_error",
        error: e instanceof Error ? e.message : String(e),
        message: "Unexpected error in OAuth callback",
      }),
    );
    return redirectErr("internal");
  }
});

export default app;
