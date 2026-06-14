import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { errorResponse } from "../utils/error";

type RateLimitEnv = { Bindings: Env };

export function rateLimit(limiterName: "UNAUTH_LIMITER" | "AUTH_LIMITER" | "EXTERNAL_LIMITER") {
  return createMiddleware<RateLimitEnv>(async (c, next) => {
    const limiter = c.env[limiterName];
    const key = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key });
    if (!success) {
      return errorResponse("RATE_LIMITED", "Rate limit exceeded", 429);
    }
    await next();
  });
}
