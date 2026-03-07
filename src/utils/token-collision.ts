import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";

/**
 * Check if a token already exists in users.calendar_token or subscriptions.calendar_token.
 */
export async function tokenExists(db: DrizzleD1Database, token: string): Promise<boolean> {
  const [userMatch] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (userMatch) return true;

  const [subMatch] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.calendarToken, token))
    .limit(1);

  return !!subMatch;
}
