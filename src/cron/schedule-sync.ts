import { drizzle } from "drizzle-orm/d1";
import { isNotNull, eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import { CQUAPIClient } from "../services/cqu-api";
import {
  PERSONAL_SOURCE_TYPES,
  fetchSessionContext,
  fetchPersonalSchedule,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
  type SessionContext,
  type PersonalScheduleData,
} from "../services/sync";

export async function syncAllSubscriptions(env: Env): Promise<void> {
  console.log("cron: starting schedule sync");
  const db = drizzle(env.DB);

  // Get all users with valid access tokens
  const activeUsers = await db
    .select()
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log("cron: no active users, skipping sync");
    return;
  }

  console.log(`cron: syncing subscriptions for ${activeUsers.length} users`);

  for (const user of activeUsers) {
    try {
      await syncUserSubscriptions(env, db, user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `cron: failed to sync subscriptions for ${user.studentId}: ${msg}`,
      );
    }
  }

  console.log("cron: schedule sync complete");
}

async function syncUserSubscriptions(
  env: Env,
  db: ReturnType<typeof drizzle>,
  user: typeof users.$inferSelect,
): Promise<void> {
  if (!user.accessToken) return;

  const userSubs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  if (userSubs.length === 0) return;

  const api = new CQUAPIClient(user.accessToken);
  const now = new Date().toISOString();

  let ctx: SessionContext | null = null;
  let personalData: PersonalScheduleData | null = null;
  let personalFetchFailed = false;

  console.log(`cron: user ${user.studentId} has ${userSubs.length} subscriptions`);

  for (const sub of userSubs) {
    try {
      if (!ctx) {
        ctx = await fetchSessionContext(api);
      }

      if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
        if (!personalData && !personalFetchFailed) {
          try {
            personalData = await fetchPersonalSchedule(api, user.studentId, ctx);
          } catch (e) {
            personalFetchFailed = true;
            console.error(
              `cron: failed to fetch personal schedule for ${user.studentId}: ${e}`,
            );
            continue;
          }
        }

        if (!personalData) continue;

        const result = await buildPersonalSyncResult(
          sub.sourceType,
          personalData,
          user.studentId,
        );
        await applySyncResult(db, sub.id, result, ctx, {
          sessionId: sub.sessionId,
          sessionName: sub.sessionName,
        });
      } else {
        try {
          const result = await buildExploreSyncResult(
            api,
            sub.sourceType,
            sub.sourceId,
            user.studentId,
            ctx,
          );
          await applySyncResult(db, sub.id, result, ctx, {
            sessionId: sub.sessionId,
            sessionName: sub.sessionName,
          });
        } catch (e) {
          console.error(
            `cron: failed to refresh subscription ${sub.sourceName}: ${e}`,
          );
          continue;
        }
      }

      console.log(
        `cron: synced ${sub.sourceName} for ${user.studentId}`,
      );
    } catch (e) {
      console.error(
        `cron: failed to sync ${sub.sourceName}: ${e}`,
      );
    }
  }

  // Update user's last refresh time
  await db
    .update(users)
    .set({ lastRefreshAt: now, updatedAt: now })
    .where(eq(users.id, user.id));
}
