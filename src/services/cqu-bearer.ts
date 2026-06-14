import type { Env } from "../types";
import { exchangeTicketForCquToken } from "./auth";
import { decodeStudentIdFromBearer } from "./cqu-api";

/** KV key prefix for the per-user cached CQU bearer token. */
const BEARER_KEY_PREFIX = "bearer:";

/** KV key prefix for the per-user resolved CQU 学号 (student ID). */
const STUDENT_KEY_PREFIX = "student:";

/**
 * TTL (seconds) for the cached student ID. A user's 学号 is effectively
 * immutable, so cache it for a long time (30 days) to avoid re-decoding the
 * bearer on every sync.
 */
const STUDENT_TTL = 30 * 24 * 3600;

/**
 * TTL (seconds) for the cached bearer. CQU OAuth tokens last ~4h; cache for ~3h
 * to refresh ahead of expiry while still cutting most ticket exchanges.
 */
const BEARER_TTL = 3 * 3600;

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
 * Resolve the CQU 学号 (student ID) of the authenticated user, bound to the
 * `userId` (auth bearer subject) — NEVER to any client-supplied input.
 *
 * The 学号 is the `user_name` claim of the CQU OAuth bearer JWT
 * ({@link decodeStudentIdFromBearer}). Because it is effectively immutable, it
 * is cached in KV (`student:<userId>`, 30d TTL) so subsequent syncs skip the
 * decode entirely.
 *
 * Returns `null` (never throws) when the bearer carries no usable student ID,
 * so personal sync can ack-and-skip a single user without failing the batch.
 * The bearer itself is sensitive and is NEVER logged here.
 */
export async function resolveOwnStudentId(
  env: Env,
  userId: string,
  bearer: string,
): Promise<string | null> {
  const cacheKey = `${STUDENT_KEY_PREFIX}${userId}`;

  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;

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

  // Best-effort cache; never block on a KV write failure.
  await env.CACHE.put(cacheKey, studentId, { expirationTtl: STUDENT_TTL }).catch(
    (e) =>
      console.warn(
        JSON.stringify({
          event: "cqu_bearer.student_id.cache.write_failed",
          userId,
          error: e instanceof Error ? e.message : String(e),
          message: "Failed to cache student ID to KV",
        }),
      ),
  );

  return studentId;
}
