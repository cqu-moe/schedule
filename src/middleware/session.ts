import { resolveApplicationSession } from "../services/application-session";
import type { Context, Next } from "hono";
import { errorResponse } from "../utils/error";
import type { Env } from "../types";
import type { SessionUser, CalendarCaps, CquBindStatus } from "../services/auth-rpc";

/**
 * Hono env for routes guarded by {@link sessionMiddleware}.
 *
 * After the middleware runs, `c.get("user")` / `c.get("caps")` are populated
 * from the centrally validated application session. Hono Context types are invariant, so handlers
 * downstream of this middleware must use this exact env shape.
 */
export type SessionEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    caps: { calendar: CalendarCaps };
    /** 可选：旧版 auth 不下发该字段，消费方须把 undefined 当「未知」。 */
    cquBindStatus?: CquBindStatus;
  };
};

/**
 * TTL (seconds) for the caps:<userId> KV cache. First half of the revocation
 * SLO (issue #87): a stale entry lives at most 10min and the reconcile cron
 * runs every 15min. When AUTH returns explicit calendar caps, is_active flips
 * within ~25min (public links ~30min incl. edge cache). Null/error responses
 * have no finite revocation bound; see
 * docs/decisions/2026-09-30-caps-revocation-slo.md.
 */
export const CAPS_TTL = 600;

/**
 * Verify the host-only application session with current OAuth introspection,
 * inject `user`/`caps` into the request context, and best-effort cache the
 * calendar caps to KV.
 *
 * The KV write populates `caps:<userId>` so the schedule-sync cron can read
 * each user's `sync_interval` offline (no session cookie at cron time); the
 * getCaps RPC is an optional fallback path.
 *
 * Returns 401 UNAUTHORIZED when the session is missing or invalid.
 */
export async function sessionMiddleware(c: Context<SessionEnv>, next: Next) {
  c.header("Cache-Control", "no-store");
  let sess;
  try { sess = await resolveApplicationSession(c); }
  catch { return errorResponse("AUTH_UNAVAILABLE", "认证服务暂不可用，请稍后重试", 503); }
  if (!sess) return errorResponse("UNAUTHORIZED", "未登录", 401);

  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== new URL(c.env.PUBLIC_URL).origin) {
    return errorResponse("FORBIDDEN", "请求来源无效", 403);
  }
  c.set("user", sess.user);
  c.set("caps", sess.caps);
  c.set("cquBindStatus", sess.cquBindStatus);

  // Cache caps for offline (cron) reads; best-effort — must NOT block the request
  // (this runs on every protected request, incl. dashboard polling). Schedule it
  // with waitUntil so it finishes after the response without adding KV latency.
  const cacheWrite = c.env.CACHE.put(
    `caps:${sess.user.id}`,
    JSON.stringify(sess.caps.calendar),
    { expirationTtl: CAPS_TTL },
  ).catch((e) => console.warn(JSON.stringify({
    event: "session.caps_cache.write_failed",
    userId: sess.user.id,
    error: e instanceof Error ? e.message : String(e),
    message: "Failed to cache caps to KV",
  })));
  try {
    c.executionCtx.waitUntil(cacheWrite);
  } catch {
    // No ExecutionContext (unit tests / non-fetch path) — await so the write still
    // completes within the request (and within the test's isolated-storage frame).
    await cacheWrite;
  }

  await next();
}
