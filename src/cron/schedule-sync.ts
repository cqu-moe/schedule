import { drizzle } from "drizzle-orm/d1";
import { isNotNull, eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import { decrypt } from "../services/crypto";
import { CQUAPIClient } from "../services/cqu-api";
import { spreadEnqueue } from "../utils/queue";
import {
  PERSONAL_SOURCE_TYPES,
  fetchSessionContextCached,
  fetchPersonalScheduleCached,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
  type PersonalScheduleData,
} from "../services/sync";

export interface ScheduleSyncMessage {
  userId: string;
  studentId: string;
}

/** Producer: enqueue all active users for schedule sync */
export async function enqueueScheduleSync(env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "cron.schedule_sync.start", message: "Enqueuing schedule sync" }));
  const db = drizzle(env.DB);

  const activeUsers = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log(JSON.stringify({ event: "cron.schedule_sync.skip", message: "No active users" }));
    return;
  }

  await spreadEnqueue(
    env.SCHEDULE_SYNC_QUEUE,
    activeUsers,
    (u) => ({ body: { userId: u.id, studentId: u.studentId } satisfies ScheduleSyncMessage }),
    21600,
    10,
  );

  console.log(JSON.stringify({ event: "cron.schedule_sync.enqueued", count: activeUsers.length, message: `Enqueued ${activeUsers.length} users for schedule sync` }));
}

/** Consumer: process a batch of schedule sync messages */
export async function processScheduleSyncBatch(
  batch: MessageBatch<ScheduleSyncMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  await Promise.allSettled(batch.messages.map(async (message) => {
    const { userId, studentId } = message.body;
    try {
      const [user] = await db
        .select({
          id: users.id,
          studentId: users.studentId,
          accessToken: users.accessToken,
          refreshToken: users.refreshToken,
          encryptedPassword: users.encryptedPassword,
          tokenExpiresAt: users.tokenExpiresAt,
        })
        .from(users)
        .where(eq(users.id, userId));

      if (!user || !user.accessToken) {
        message.ack();
        return;
      }

      const userSubs = await db
        .select({
          id: subscriptions.id,
          sourceType: subscriptions.sourceType,
          sourceId: subscriptions.sourceId,
          sourceName: subscriptions.sourceName,
          sessionId: subscriptions.sessionId,
          sessionName: subscriptions.sessionName,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId));

      if (userSubs.length === 0) {
        message.ack();
        return;
      }

      const accessToken = await decrypt(user.accessToken!, env.ENCRYPTION_KEY);
      const api = new CQUAPIClient(accessToken);
      const now = new Date().toISOString();
      const ctx = await fetchSessionContextCached(api, env.CACHE);

      // Split subscriptions by type
      const personalSubs = userSubs.filter((s) => PERSONAL_SOURCE_TYPES.has(s.sourceType));
      const exploreSubs = userSubs.filter((s) => !PERSONAL_SOURCE_TYPES.has(s.sourceType));

      let personalFetchFailed = false;
      let syncedAny = false;

      // Process personal subscriptions
      if (personalSubs.length > 0) {
        let personalData: PersonalScheduleData | null = null;
        try {
          personalData = await fetchPersonalScheduleCached(api, user.studentId, ctx, env.CACHE);
        } catch (e) {
          personalFetchFailed = true;
          console.error(JSON.stringify({ event: "queue.schedule_sync.personal_failed", studentId, error: e instanceof Error ? e.message : String(e), message: "Personal schedule fetch failed" }));
        }

        if (personalData) {
          const personalResults = await Promise.allSettled(
            personalSubs.map(async (sub) => {
              const result = await buildPersonalSyncResult(sub.sourceType, personalData!, user.studentId);
              await applySyncResult(db, sub.id, result, ctx, {
                sessionId: sub.sessionId,
                sessionName: sub.sessionName,
              });
              console.log(JSON.stringify({ event: "queue.schedule_sync.subscription_synced", studentId, source: sub.sourceName, message: "Subscription synced" }));
            }),
          );
          if (personalResults.some((r) => r.status === "fulfilled")) syncedAny = true;
          if (personalResults.some((r) => r.status === "rejected")) personalFetchFailed = true;
        }
      }

      // Process explore subscriptions in parallel
      let exploreFetchFailed = false;
      if (exploreSubs.length > 0) {
        const exploreResults = await Promise.allSettled(
          exploreSubs.map(async (sub) => {
            const result = await buildExploreSyncResult(
              api, sub.sourceType, sub.sourceId, user.studentId, ctx,
            );
            await applySyncResult(db, sub.id, result, ctx, {
              sessionId: sub.sessionId,
              sessionName: sub.sessionName,
            });
            console.log(JSON.stringify({ event: "queue.schedule_sync.subscription_synced", studentId, source: sub.sourceName, message: "Subscription synced" }));
          }),
        );
        exploreFetchFailed = exploreResults.some((r) => r.status === "rejected");
        if (exploreResults.some((r) => r.status === "fulfilled")) syncedAny = true;

        // Log explore failures
        for (let i = 0; i < exploreResults.length; i++) {
          const r = exploreResults[i];
          if (r.status === "rejected") {
            console.error(JSON.stringify({ event: "queue.schedule_sync.explore_failed", studentId, source: exploreSubs[i].sourceName, error: r.reason instanceof Error ? r.reason.message : String(r.reason), message: "Explore subscription fetch failed" }));
          }
        }
      }

      // If any fetch failed and nothing was synced, retry
      if ((personalFetchFailed || exploreFetchFailed) && !syncedAny) {
        console.warn(JSON.stringify({ event: "queue.schedule_sync.all_failed", studentId, message: "All syncs failed, retrying" }));
        message.retry();
        return;
      }

      await db
        .update(users)
        .set({ lastRefreshAt: now, updatedAt: now })
        .where(eq(users.id, userId));

      message.ack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ event: "queue.schedule_sync.failed", studentId, error: msg, message: "Schedule sync failed" }));
      message.retry();
    }
  }));
}
