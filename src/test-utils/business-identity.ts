import type { MiddlewareHandler } from "hono";
import type { SessionEnv } from "../middleware/session";
import { errorResponse } from "../utils/error";

// Business-route fixtures supply an identity context, not an authentication
// implementation. The real OAuth/session boundary is owned by application-auth.test.ts.
export const businessIdentity: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const session = await c.env.AUTH.verifySession("");
  if (!session) return errorResponse("UNAUTHORIZED", "未登录", 401);
  c.set("user", session.user); c.set("caps", session.caps); c.set("cquBindStatus", session.cquBindStatus);
  await next();
};
