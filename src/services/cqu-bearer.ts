import type { Env } from "../types";
import { exchangeTicketForCquToken } from "./auth";
import { decodeStudentIdFromBearer } from "./cqu-api";

/** KV key prefix for the per-user cached CQU bearer token. */
const BEARER_KEY_PREFIX = "bearer:";

/**
 * TTL (seconds) for the cached bearer. CQU OAuth tokens last ~4h; cache for ~1h
 * so a re-bound / revoked CQU account can't keep being used much past that, while
 * still cutting most ticket exchanges. Revocation also self-heals faster via
 * {@link invalidateCquBearer} on a 401.
 */
const BEARER_TTL = 1 * 3600;

/**
 * Resolve a CQU教务 bearer token for a user via the auth service (拓扑①).
 *
 * Flow:
 *  1. KV cache hit (`bearer:<userId>`) → return immediately.
 *  2. Miss → `env.AUTH.getCquTicket({clientId:"calendar", service:"jwxt", userId})`.
 *     - On `{ error }` (e.g. SESSION_INACTIVE) → structured-log and return `null`;
 *       callers skip the work, never throw.
 *  3. On `{ ticket }` → `exchangeTicketForCquToken(ticket)` → accessToken (bearer)
 *     → best-effort cache to KV → return bearer.
 *
 * Returns `null` (never throws) whenever a bearer cannot be obtained, so queue
 * consumers can ack-and-skip a single user without failing the batch.
 *
 * The bearer is sensitive and is NEVER logged.
 */
export async function getCquBearer(
  env: Env,
  userId: string,
): Promise<string | null> {
  const cacheKey = `${BEARER_KEY_PREFIX}${userId}`;

  // 1. Cache hit.
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;

  // 2. Mint a fresh CQU service ticket via auth.
  const ticketResult = await env.AUTH.getCquTicket({
    clientId: "calendar",
    service: "jwxt",
    userId,
  });

  if ("error" in ticketResult) {
    console.log(
      JSON.stringify({
        event: "cqu_bearer.ticket.skip",
        userId,
        error: ticketResult.error,
        message: "getCquTicket returned error; skipping user",
      }),
    );
    return null;
  }

  // 3. Exchange the ticket for a CQU OAuth bearer.
  let bearer: string;
  try {
    const token = await exchangeTicketForCquToken(ticketResult.ticket);
    bearer = token.accessToken;
  } catch (e) {
    console.log(
      JSON.stringify({
        event: "cqu_bearer.exchange.failed",
        userId,
        error: e instanceof Error ? e.message : String(e),
        message: "Ticket exchange failed; skipping user",
      }),
    );
    return null;
  }

  // Best-effort cache; never block on a KV write failure.
  await env.CACHE.put(cacheKey, bearer, { expirationTtl: BEARER_TTL }).catch(
    (e) =>
      console.warn(
        JSON.stringify({
          event: "cqu_bearer.cache.write_failed",
          userId,
          error: e instanceof Error ? e.message : String(e),
          message: "Failed to cache bearer to KV",
        }),
      ),
  );

  return bearer;
}

/**
 * Drop the cached bearer for a user so the next {@link getCquBearer} re-mints via
 * auth. Call this when CQU rejects the bearer (401): a revoked/unbound account
 * then resolves to `SESSION_INACTIVE` on the next mint instead of silently reusing
 * a stale token until TTL. Best-effort; never throws.
 */
export async function invalidateCquBearer(env: Env, userId: string): Promise<void> {
  await env.CACHE.delete(`${BEARER_KEY_PREFIX}${userId}`).catch((e) =>
    console.warn(
      JSON.stringify({
        event: "cqu_bearer.invalidate.failed",
        userId,
        error: e instanceof Error ? e.message : String(e),
        message: "Failed to delete cached bearer",
      }),
    ),
  );
}

/**
 * Resolve the CQU 学号 (student ID) of the authenticated user from the CURRENT
 * bearer's `user_name` claim ({@link decodeStudentIdFromBearer}) — NEVER from any
 * client-supplied input.
 *
 * Decoded fresh from the bearer on every call (a cheap JWT base64 parse, no I/O)
 * and intentionally NOT cached by `userId`: an auth account can rebind to a
 * different CQU account, and a stale `student:<userId>` cache would make the new
 * bearer fetch the OLD student's schedule (cross-student leak). The 学号 is thus
 * always tied to the identity of the bearer actually being used.
 *
 * Returns `null` when the bearer carries no usable student ID, so personal sync
 * can ack-and-skip a single user without failing the batch. The bearer itself is
 * sensitive and is NEVER logged here. `userId` is for log correlation only.
 */
export function resolveOwnStudentId(bearer: string, userId: string): string | null {
  const studentId = decodeStudentIdFromBearer(bearer);
  if (!studentId) {
    console.log(
      JSON.stringify({
        event: "cqu_bearer.student_id.unresolved",
        userId,
        message: "Bearer carries no student ID; skipping user",
      }),
    );
    return null;
  }
  return studentId;
}
