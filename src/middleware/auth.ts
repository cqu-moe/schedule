import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, type User } from "../db/schema";
import type { Env } from "../types";

type AuthEnv = { Bindings: Env; Variables: { user: User } };

async function lookupUser(c: any): Promise<User | Response> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ detail: "Invalid authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const db = drizzle(c.env.DB);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return c.json({ detail: "Invalid token" }, 401);
  }

  return user;
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const result = await lookupUser(c);
  if (result instanceof Response) return result;

  c.set("user", result);
  await next();
});

export const requireAuthWithCquToken = createMiddleware<AuthEnv>(
  async (c, next) => {
    const result = await lookupUser(c);
    if (result instanceof Response) return result;

    if (!result.accessToken) {
      return c.json({ detail: "CQU token expired, please re-login" }, 401);
    }

    c.set("user", result);
    await next();
  },
);
