import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";

/**
 * Check if a token already exists in users.calendar_token,
 * users.pending_calendar_token, or subscriptions.calendar_token.
 * Also checks an optional set of in-memory tokens (for batch generation).
 */
export async function tokenExists(
  db: DrizzleD1Database,
  token: string,
  inMemoryTokens?: Set<string>,
): Promise<boolean> {
  if (inMemoryTokens?.has(token)) return true;

  const [userMatch, pendingMatch, subMatch] = await Promise.all([
    db.select({ id: users.id }).from(users)
      .where(eq(users.calendarToken, token)).limit(1),
    db.select({ id: users.id }).from(users)
      .where(eq(users.pendingCalendarToken, token)).limit(1),
    db.select({ id: subscriptions.id }).from(subscriptions)
      .where(eq(subscriptions.calendarToken, token)).limit(1),
  ]);

  return !!(userMatch.length || pendingMatch.length || subMatch.length);
}
