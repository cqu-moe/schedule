import type { Context, Next } from "hono";
import { errorResponse } from "../utils/error";
import type { Env } from "../types";
import type { SessionUser, CalendarCaps } from "../services/auth-rpc";

/**
 * Hono env for routes guarded by {@link sessionMiddleware}.
 *
 * After the middleware runs, `c.get("user")` / `c.get("caps")` are populated
 * from the auth-verified session. Hono Context types are invariant, so handlers
 * downstream of this middleware must use this exact env shape.
 */
export type SessionEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; caps: { calendar: CalendarCaps } };
};

/** TTL (seconds) for the caps:<userId> KV cache read by cron consumers. */
const CAPS_TTL = 3600;

/**
 * Verify the browser session via the auth Worker (拓扑① Service Binding RPC),
 * inject `user`/`caps` into the request context, and best-effort cache the
 * calendar caps to KV so offline (cron) consumers can read them.
 *
 * Returns 401 UNAUTHORIZED when the session is missing or invalid.
 */
export async function sessionMiddleware(c: Context<SessionEnv>, next: Next) {
  const cookie = c.req.header("cookie") ?? "";
  const sess = await c.env.AUTH.verifySession(cookie);
  if (!sess) return errorResponse("UNAUTHORIZED", "未登录", 401);

  c.set("user", sess.user);
  c.set("caps", sess.caps);

  // Cache caps for offline (cron) reads; best-effort — never block the request.
  await c.env.CACHE.put(
    `caps:${sess.user.id}`,
    JSON.stringify(sess.caps.calendar),
    { expirationTtl: CAPS_TTL },
  ).catch(() => {});

  await next();
}
