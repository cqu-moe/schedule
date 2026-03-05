import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, type User } from "../db/schema";
import type { Env } from "../types";
import { errorResponse } from "../utils/error";

/** Light user: no encrypted fields, for routes that don't need CQU tokens */
export type LightUser = Pick<User, 'id' | 'studentId' | 'calendarToken' | 'createdAt' | 'lastRefreshAt'>;

/** Auth user: adds accessToken for routes that call CQU API */
export type AuthUser = LightUser & Pick<User, 'accessToken'>;

function parseToken(c: Context): string | Response {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("UNAUTHORIZED", "Invalid authorization header", 401);
  }
  return authHeader.slice(7);
}

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: LightUser };
}>(async (c, next) => {
  const token = parseToken(c);
  if (token instanceof Response) return token;

  const db = drizzle(c.env.DB);
  const [user] = await db
    .select({
      id: users.id,
      studentId: users.studentId,
      calendarToken: users.calendarToken,
      createdAt: users.createdAt,
      lastRefreshAt: users.lastRefreshAt,
    })
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return errorResponse("UNAUTHORIZED", "Invalid token", 401);
  }

  c.set("user", user);
  await next();
});

export const requireAuthWithCquToken = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const token = parseToken(c);
  if (token instanceof Response) return token;

  const db = drizzle(c.env.DB);
  const [user] = await db
    .select({
      id: users.id,
      studentId: users.studentId,
      calendarToken: users.calendarToken,
      createdAt: users.createdAt,
      lastRefreshAt: users.lastRefreshAt,
      accessToken: users.accessToken,
    })
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return errorResponse("UNAUTHORIZED", "Invalid token", 401);
  }

  if (!user.accessToken) {
    return errorResponse("TOKEN_EXPIRED", "CQU token expired, please re-login", 401);
  }

  c.set("user", user);
  await next();
});
