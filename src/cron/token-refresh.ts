import { drizzle } from "drizzle-orm/d1";
import { lt, isNotNull, eq, and } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env } from "../types";
import { encrypt, decrypt } from "../services/crypto";
import {
  refreshToken,
  login,
  exchangeTicketForCquToken,
  AuthError,
} from "../services/auth";
import {
  refreshAuthToken,
  getServiceTicket,
  AuthOAuthError,
} from "../services/auth-oauth-client";
import { spreadEnqueue } from "../utils/queue";

export interface TokenRefreshMessage {
  userId: string;
  studentId: string;
}

/** auth refresh token lifetime is 30 days; rotate proactively once it crosses this age (D8). */
const AUTH_REFRESH_ROTATE_MS = 25 * 24 * 60 * 60 * 1000;

/** Producer: query users needing refresh, send to queue */
export async function enqueueTokenRefresh(env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "cron.token_refresh.start", message: "Enqueuing token refresh" }));
  const db = drizzle(env.DB);

  const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const expiring = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(and(isNotNull(users.tokenExpiresAt), lt(users.tokenExpiresAt, threshold)));

  if (expiring.length === 0) {
    console.log(JSON.stringify({ event: "cron.token_refresh.skip", message: "No users need token refresh" }));
    return;
  }

  await spreadEnqueue(
    env.TOKEN_REFRESH_QUEUE,
    expiring,
    (u) => ({ body: { userId: u.id, studentId: u.studentId } satisfies TokenRefreshMessage }),
    3600,
    5,
  );

  console.log(JSON.stringify({ event: "cron.token_refresh.enqueued", count: expiring.length, message: `Enqueued ${expiring.length} users for token refresh` }));
}

/**
 * Refresh the auth refresh token and re-issue CQU tokens for an AUTH account.
 *
 * Returns the rotated auth refresh token (or "" when the provider did NOT
 * rotate, in which case the caller keeps the existing stored token).
 */
async function remintCquFromAuth(
  env: Env,
  decryptedAuthRefresh: string,
): Promise<{ cqu: Awaited<ReturnType<typeof exchangeTicketForCquToken>>; newAuthRefresh: string }> {
  // grant_type=refresh_token → new auth access token (+ maybe rotated refresh token)
  const authTokens = await refreshAuthToken(env, decryptedAuthRefresh);
  // service-ticket → CAS ST → CQU bearer tokens (no CASTGC cookie on this path)
  const ticket = await getServiceTicket(authTokens.accessToken);
  const cqu = await exchangeTicketForCquToken(ticket);
  return { cqu, newAuthRefresh: authTokens.refreshToken };
}

/** Consumer: process a batch of token refresh messages */
export async function processTokenRefreshBatch(
  batch: MessageBatch<TokenRefreshMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const { userId, studentId } = message.body;
      try {
        // Read fresh user data (token/auth-refresh may have been rotated by another delivery)
        const [user] = await db
          .select({
            id: users.id,
            studentId: users.studentId,
            refreshToken: users.refreshToken,
            encryptedPassword: users.encryptedPassword,
            tokenExpiresAt: users.tokenExpiresAt,
            authUserId: users.authUserId,
            authRefreshToken: users.authRefreshToken,
            authRefreshIssuedAt: users.authRefreshIssuedAt,
          })
          .from(users)
          .where(eq(users.id, userId));

        if (!user) {
          message.ack();
          return;
        }

        const isAuthAccount = user.authUserId !== null && user.authUserId !== undefined;

        // ── Early-exit gate ───────────────────────────────────────────────
        // Compute BOTH needsCquRefresh AND needsAuthRotation; early-ack only
        // when both are false. Otherwise a delivery that observes a fresh CQU
        // token would skip a still-due auth rotation (D8 keep-alive lost).
        const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        const needsCquRefresh = !!user.tokenExpiresAt && user.tokenExpiresAt < threshold;
        const needsAuthRotation =
          isAuthAccount && isAuthRefreshStale(user.authRefreshIssuedAt);

        if (!needsCquRefresh && !needsAuthRotation) {
          message.ack();
          return;
        }

        const now = new Date().toISOString();

        // ── Branch: AUTH account ──────────────────────────────────────────
        if (isAuthAccount) {
          // CQU is still fresh but an auth rotation is due → auth-only rotation.
          if (!needsCquRefresh) {
            await rotateAuthRefresh(env, db, userId, studentId, user.authRefreshToken, now);
            message.ack();
            return;
          }

          // CQU needs refresh: try CQU refresh_token first (same as password
          // accounts). On TOKEN_EXPIRED fall back to an auth re-mint.
          let cquRefreshed = false;
          if (user.refreshToken) {
            try {
              const decryptedRefreshToken = await decrypt(user.refreshToken, env.ENCRYPTION_KEY);
              const result = await refreshToken(decryptedRefreshToken);
              await db
                .update(users)
                .set({
                  accessToken: await encrypt(result.accessToken, env.ENCRYPTION_KEY),
                  refreshToken: await encrypt(result.refreshToken, env.ENCRYPTION_KEY),
                  tokenExpiresAt: result.expiresAt,
                  lastRefreshAt: now,
                  loginError: null,
                  updatedAt: now,
                })
                .where(eq(users.id, userId));
              console.log(JSON.stringify({ event: "queue.token_refresh.success", studentId, message: "Token refreshed" }));
              cquRefreshed = true;
            } catch (e) {
              if (!(e instanceof AuthError) || e.code !== "TOKEN_EXPIRED") {
                throw e;
              }
              console.warn(JSON.stringify({ event: "queue.token_refresh.auth_remint", studentId, message: "CQU refresh token expired, re-minting via auth" }));
            }
          }

          if (!cquRefreshed) {
            // Auth re-mint: refreshAuthToken → service-ticket → exchangeTicket.
            if (!user.authRefreshToken) {
              throw new AuthOAuthError("no_auth_refresh", "No stored auth refresh token", "user");
            }
            const decryptedAuthRefresh = await decrypt(user.authRefreshToken, env.ENCRYPTION_KEY);
            let reminted;
            try {
              reminted = await remintCquFromAuth(env, decryptedAuthRefresh);
            } catch (e) {
              await handleAuthRemintError(env, db, userId, studentId, user, e, message);
              return;
            }
            const newAuthRefreshEnc =
              reminted.newAuthRefresh !== ""
                ? await encrypt(reminted.newAuthRefresh, env.ENCRYPTION_KEY)
                : user.authRefreshToken; // keep existing when provider did not rotate
            await db
              .update(users)
              .set({
                accessToken: await encrypt(reminted.cqu.accessToken, env.ENCRYPTION_KEY),
                refreshToken: await encrypt(reminted.cqu.refreshToken, env.ENCRYPTION_KEY),
                tokenExpiresAt: reminted.cqu.expiresAt,
                authRefreshToken: newAuthRefreshEnc,
                authRefreshIssuedAt: now,
                lastLoginAt: now,
                lastRefreshAt: now,
                loginError: null,
                updatedAt: now,
              })
              .where(eq(users.id, userId));
            console.log(JSON.stringify({ event: "queue.token_refresh.auth_remint_success", studentId, message: "Auth re-mint successful" }));
            message.ack();
            return;
          }

          // CQU refresh SUCCEEDED and was persisted. Now, if an auth rotation
          // is also due (D8), do it as a best-effort proactive rotation. A
          // transient failure here must NOT fail the message nor roll back the
          // already-valid CQU token.
          if (needsAuthRotation) {
            await rotateAuthRefreshBestEffort(env, db, userId, studentId, user.authRefreshToken, now);
          }
          message.ack();
          return;
        }

        // ── Branch: PASSWORD account (unchanged behavior) ─────────────────
        // Try refresh token first
        if (user.refreshToken) {
          try {
            const decryptedRefreshToken = await decrypt(user.refreshToken, env.ENCRYPTION_KEY);
            const result = await refreshToken(decryptedRefreshToken);
            await db
              .update(users)
              .set({
                accessToken: await encrypt(result.accessToken, env.ENCRYPTION_KEY),
                refreshToken: await encrypt(result.refreshToken, env.ENCRYPTION_KEY),
                tokenExpiresAt: result.expiresAt,
                lastRefreshAt: now,
                loginError: null,
                updatedAt: now,
              })
              .where(eq(users.id, userId));
            console.log(JSON.stringify({ event: "queue.token_refresh.success", studentId, message: "Token refreshed" }));
            message.ack();
            return;
          } catch (e) {
            if (!(e instanceof AuthError) || e.code !== "TOKEN_EXPIRED") {
              throw e;
            }
            console.warn(JSON.stringify({ event: "queue.token_refresh.fallback_login", studentId, message: "Refresh token expired, trying login" }));
          }
        }

        // Fallback: re-login (only possible for password accounts with a real password)
        if (!user.encryptedPassword) {
          throw new AuthError("INVALID_CREDENTIALS", "No stored password for re-login");
        }
        const password = await decrypt(user.encryptedPassword, env.ENCRYPTION_KEY);
        const result = await login(user.studentId, password);
        await db
          .update(users)
          .set({
            accessToken: await encrypt(result.accessToken, env.ENCRYPTION_KEY),
            refreshToken: await encrypt(result.refreshToken, env.ENCRYPTION_KEY),
            tokenExpiresAt: result.expiresAt,
            lastLoginAt: now,
            lastRefreshAt: now,
            loginError: null,
            updatedAt: now,
          })
          .where(eq(users.id, userId));
        console.log(JSON.stringify({ event: "queue.token_refresh.login_success", studentId, message: "Re-login successful" }));
        message.ack();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ event: "queue.token_refresh.failed", studentId, error: msg, message: "Token refresh failed" }));

        // Permanent failures → ack and record error, don't retry
        if (e instanceof AuthError && (e.code === "INVALID_CREDENTIALS" || e.code === "CAPTCHA_REQUIRED")) {
          await db
            .update(users)
            .set({ loginError: msg, updatedAt: new Date().toISOString() })
            .where(eq(users.id, userId));
          message.ack();
          return;
        }

        // Transient failures → retry (timeout, network, upstream errors)
        await db
          .update(users)
          .set({ loginError: msg, updatedAt: new Date().toISOString() })
          .where(eq(users.id, userId));
        message.retry();
      }
    }),
  );
}

/** True when an AUTH account's refresh token is older than the rotation window (D8). */
function isAuthRefreshStale(authRefreshIssuedAt: string | null | undefined): boolean {
  if (!authRefreshIssuedAt) return false;
  const issued = Date.parse(authRefreshIssuedAt);
  if (Number.isNaN(issued)) return false;
  return Date.now() - issued > AUTH_REFRESH_ROTATE_MS;
}

/**
 * Auth-only rotation (CQU token is still valid). Refresh the auth token and
 * persist the rotated refresh token / issued-at. Errors here are bucketed the
 * same way as the re-mint path but are recorded as warnings — the CQU token is
 * unaffected this round. Throws transient errors so the message can retry the
 * rotation; user/operator-permanent failures are recorded and swallowed.
 */
async function rotateAuthRefresh(
  env: Env,
  db: ReturnType<typeof drizzle>,
  userId: string,
  studentId: string,
  authRefreshTokenEnc: string | null | undefined,
  now: string,
): Promise<void> {
  if (!authRefreshTokenEnc) {
    console.warn(JSON.stringify({ event: "queue.token_refresh.rotate_skip", studentId, message: "No auth refresh token to rotate" }));
    return;
  }
  const decryptedAuthRefresh = await decrypt(authRefreshTokenEnc, env.ENCRYPTION_KEY);
  try {
    const authTokens = await refreshAuthToken(env, decryptedAuthRefresh);
    const newAuthRefreshEnc =
      authTokens.refreshToken !== ""
        ? await encrypt(authTokens.refreshToken, env.ENCRYPTION_KEY)
        : authRefreshTokenEnc; // keep existing when not rotated
    await db
      .update(users)
      .set({
        authRefreshToken: newAuthRefreshEnc,
        authRefreshIssuedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    console.log(JSON.stringify({ event: "queue.token_refresh.rotate_success", studentId, message: "Auth refresh token rotated" }));
  } catch (e) {
    // Benign race: another delivery already rotated this token.
    if (e instanceof AuthOAuthError && e.code === "invalid_grant") {
      const stillStale = await isRotationStillNeeded(db, userId, authRefreshTokenEnc);
      if (!stillStale) {
        console.log(JSON.stringify({ event: "queue.token_refresh.rotate_benign_race", studentId, message: "Auth rotation already done by another delivery" }));
        return;
      }
    }
    if (e instanceof AuthOAuthError && e.kind === "transient") {
      // surface so the message retries the rotation
      throw e;
    }
    // user/operator-permanent: record + swallow (CQU is valid this round)
    const msg = e instanceof Error ? e.message : String(e);
    const event = e instanceof AuthOAuthError && e.kind === "operator"
      ? "queue.token_refresh.operator_error"
      : "queue.token_refresh.rotate_permanent";
    console.error(JSON.stringify({ event, studentId, error: msg, message: "Auth-only rotation failed permanently" }));
    await db
      .update(users)
      .set({ loginError: msg, updatedAt: now })
      .where(eq(users.id, userId));
  }
}

/**
 * D8 proactive rotation invoked AFTER a successful CQU refresh. Identical to
 * rotateAuthRefresh but NEVER throws — a transient failure must not fail the
 * message (the CQU token is valid this round), and an operator/user-permanent
 * failure is recorded but not retry-stormed.
 */
async function rotateAuthRefreshBestEffort(
  env: Env,
  db: ReturnType<typeof drizzle>,
  userId: string,
  studentId: string,
  authRefreshTokenEnc: string | null | undefined,
  now: string,
): Promise<void> {
  if (!authRefreshTokenEnc) return;
  const decryptedAuthRefresh = await decrypt(authRefreshTokenEnc, env.ENCRYPTION_KEY);
  try {
    const authTokens = await refreshAuthToken(env, decryptedAuthRefresh);
    const newAuthRefreshEnc =
      authTokens.refreshToken !== ""
        ? await encrypt(authTokens.refreshToken, env.ENCRYPTION_KEY)
        : authRefreshTokenEnc;
    await db
      .update(users)
      .set({
        authRefreshToken: newAuthRefreshEnc,
        authRefreshIssuedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    console.log(JSON.stringify({ event: "queue.token_refresh.rotate_success", studentId, message: "Proactive auth refresh token rotation" }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const event = e instanceof AuthOAuthError && e.kind === "operator"
      ? "queue.token_refresh.operator_error"
      : "queue.token_refresh.rotate_proactive_failed";
    console.warn(JSON.stringify({ event, studentId, error: msg, message: "Proactive auth rotation failed (CQU token still valid this round)" }));
    // Do NOT throw, do NOT roll back the persisted CQU token.
  }
}

/**
 * Re-read the user row and decide whether an auth rotation is still required
 * for benign-race detection: if the stored authRefreshToken differs from the
 * token we tried (another delivery already rotated) or it is no longer stale,
 * the failure is benign.
 */
async function isRotationStillNeeded(
  db: ReturnType<typeof drizzle>,
  userId: string,
  triedAuthRefreshTokenEnc: string,
): Promise<boolean> {
  const [fresh] = await db
    .select({
      authRefreshToken: users.authRefreshToken,
      authRefreshIssuedAt: users.authRefreshIssuedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!fresh) return false;
  if (fresh.authRefreshToken !== triedAuthRefreshTokenEnc) return false; // another delivery rotated
  return isAuthRefreshStale(fresh.authRefreshIssuedAt);
}

/**
 * Classify a failure of the auth re-mint fallback (CQU refresh already failed
 * with TOKEN_EXPIRED, so a valid CQU token is NOT available this round) into
 * the three buckets and ack/retry accordingly.
 *
 *   user-permanent      → ack + loginError (must re-OAuth), confirmed by the
 *                         benign-race reread for invalid_grant.
 *   operator-permanent  → ack + loginError + operator_error log.
 *   transient / unknown → retry + loginError.
 */
async function handleAuthRemintError(
  env: Env,
  db: ReturnType<typeof drizzle>,
  userId: string,
  studentId: string,
  user: {
    authRefreshToken: string | null;
    authRefreshIssuedAt: string | null;
  },
  e: unknown,
  message: Message<TokenRefreshMessage>,
): Promise<void> {
  const msg = e instanceof Error ? e.message : String(e);
  const now = new Date().toISOString();

  if (e instanceof AuthOAuthError) {
    // Benign race: an invalid_grant on the auth refresh token may mean another
    // delivery already rotated it. Re-read; if the token changed or is no
    // longer stale, treat as benign and ack (NOT permanent).
    if (e.code === "invalid_grant" && user.authRefreshToken) {
      const [fresh] = await db
        .select({
          authRefreshToken: users.authRefreshToken,
          authRefreshIssuedAt: users.authRefreshIssuedAt,
          tokenExpiresAt: users.tokenExpiresAt,
        })
        .from(users)
        .where(eq(users.id, userId));
      const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const tokenChanged = fresh && fresh.authRefreshToken !== user.authRefreshToken;
      const cquFreshNow = fresh && (!fresh.tokenExpiresAt || fresh.tokenExpiresAt >= threshold);
      if (tokenChanged || cquFreshNow) {
        console.log(JSON.stringify({ event: "queue.token_refresh.remint_benign_race", studentId, message: "Auth refresh token already rotated by another delivery" }));
        message.ack();
        return;
      }
      // Reread confirms it's still the same stale token that failed → user-permanent.
      console.error(JSON.stringify({ event: "queue.token_refresh.user_error", studentId, error: msg, message: "Auth grant revoked/expired; user must re-OAuth" }));
      await db
        .update(users)
        .set({ loginError: msg, updatedAt: now })
        .where(eq(users.id, userId));
      message.ack();
      return;
    }

    if (e.kind === "user") {
      console.error(JSON.stringify({ event: "queue.token_refresh.user_error", studentId, error: msg, message: "User must re-OAuth" }));
      await db
        .update(users)
        .set({ loginError: msg, updatedAt: now })
        .where(eq(users.id, userId));
      message.ack();
      return;
    }

    if (e.kind === "operator") {
      console.error(JSON.stringify({ event: "queue.token_refresh.operator_error", studentId, error: msg, code: e.code, message: "OAuth client/scope misconfigured; operator must intervene" }));
      await db
        .update(users)
        .set({ loginError: msg, updatedAt: now })
        .where(eq(users.id, userId));
      message.ack();
      return;
    }

    // transient
    console.warn(JSON.stringify({ event: "queue.token_refresh.transient", studentId, error: msg, message: "Transient auth re-mint failure; retrying" }));
    await db
      .update(users)
      .set({ loginError: msg, updatedAt: now })
      .where(eq(users.id, userId));
    message.retry();
    return;
  }

  // Any other / ambiguous error → transient retry.
  console.warn(JSON.stringify({ event: "queue.token_refresh.transient", studentId, error: msg, message: "Ambiguous auth re-mint failure; retrying" }));
  await db
    .update(users)
    .set({ loginError: msg, updatedAt: now })
    .where(eq(users.id, userId));
  message.retry();
}
