import { drizzle } from "drizzle-orm/d1";
import { isNotNull, eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import { decryptOrPlaintext } from "../services/crypto";
import { CQUAPIClient } from "../services/cqu-api";
import {
  PERSONAL_SOURCE_TYPES,
  fetchSessionContextCached,
  fetchPersonalSchedule,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
  type SessionContext,
  type PersonalScheduleData,
} from "../services/sync";

export interface ScheduleSyncMessage {
  userId: string;
  studentId: string;
}

/** Producer: enqueue all active users for schedule sync */
export async function enqueueScheduleSync(env: Env): Promise<void> {
  console.log("cron: enqueuing schedule sync");
  const db = drizzle(env.DB);

  const activeUsers = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log("cron: no active users, skipping sync");
    return;
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < activeUsers.length; i += BATCH_SIZE) {
    const chunk = activeUsers.slice(i, i + BATCH_SIZE);
    await env.SCHEDULE_SYNC_QUEUE.sendBatch(
      chunk.map((u) => ({
        body: { userId: u.id, studentId: u.studentId } satisfies ScheduleSyncMessage,
      })),
    );
  }

  console.log(`cron: enqueued ${activeUsers.length} users for schedule sync`);
}

/** Consumer: process a batch of schedule sync messages */
export async function processScheduleSyncBatch(
  batch: MessageBatch<ScheduleSyncMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  for (const message of batch.messages) {
    const { userId, studentId } = message.body;
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));

      if (!user || !user.accessToken) {
        message.ack();
        continue;
      }

      const userSubs = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId));

      if (userSubs.length === 0) {
        message.ack();
        continue;
      }

      // TODO(#13): 收敛后替换为 decrypt()
      const accessToken = await decryptOrPlaintext(user.accessToken!, env.ENCRYPTION_KEY);
      const api = new CQUAPIClient(accessToken);
      const now = new Date().toISOString();
      const ctx = await fetchSessionContextCached(api, env.CACHE);

      let personalData: PersonalScheduleData | null = null;
      let personalFetchFailed = false;
      let exploreFetchFailed = false;
      let syncedAny = false;

      for (const sub of userSubs) {
        if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
          if (!personalData && !personalFetchFailed) {
            try {
              personalData = await fetchPersonalSchedule(api, user.studentId, ctx);
            } catch (e) {
              personalFetchFailed = true;
              console.error(`queue: failed to fetch personal schedule for ${studentId}: ${e}`);
              continue;
            }
          }
          if (!personalData) continue;

          const result = await buildPersonalSyncResult(sub.sourceType, personalData, user.studentId);
          await applySyncResult(db, sub.id, result, ctx, {
            sessionId: sub.sessionId,
            sessionName: sub.sessionName,
          });
        } else {
          try {
            const result = await buildExploreSyncResult(
              api, sub.sourceType, sub.sourceId, user.studentId, ctx,
            );
            await applySyncResult(db, sub.id, result, ctx, {
              sessionId: sub.sessionId,
              sessionName: sub.sessionName,
            });
          } catch (e) {
            exploreFetchFailed = true;
            console.error(`queue: failed to refresh subscription ${sub.sourceName}: ${e}`);
            continue;
          }
        }
        syncedAny = true;
        console.log(`queue: synced ${sub.sourceName} for ${studentId}`);
      }

      // If any fetch failed and nothing was synced, retry
      if ((personalFetchFailed || exploreFetchFailed) && !syncedAny) {
        console.warn(`queue: all syncs failed for ${studentId}, retrying`);
        message.retry();
        continue;
      }

      await db
        .update(users)
        .set({ lastRefreshAt: now, updatedAt: now })
        .where(eq(users.id, userId));

      message.ack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`queue: schedule sync failed for ${studentId}: ${msg}`);
      message.retry();
    }
  }
}
