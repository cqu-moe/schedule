import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

type RateLimitEnv = { Bindings: Env };

export function rateLimit(limiterName: "UNAUTH_LIMITER" | "AUTH_LIMITER" | "EXPLORE_LIMITER") {
  return createMiddleware<RateLimitEnv>(async (c, next) => {
    const limiter = c.env[limiterName];
    const key = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key });
    if (!success) {
      return c.json({ detail: "Rate limit exceeded" }, 429);
    }
    await next();
  });
}
