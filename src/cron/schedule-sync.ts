import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  subscriptions,
  PERSONAL_SOURCE_TYPES,
  type ExploreSourceType,
} from "../db/schema";
import type { Env } from "../types";
import { CQUAPIClient } from "../services/cqu-api";
import { getCquBearer } from "../services/cqu-bearer";
import { spreadEnqueue } from "../utils/queue";
import {
  fetchSessionContextCached,
  fetchPersonalScheduleCached,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
  preGenerateIcs,
} from "../services/sync";

/** Queue message: one subscription to sync for a given auth user. */
export interface ScheduleSyncMessage {
  subscriptionId: string;
  userId: string;
}

/** Default sync interval (minutes) when caps are missing/unparseable. */
const DEFAULT_SYNC_INTERVAL_MINUTES = 1440;

/** Spread window (seconds) over which to scatter enqueued sync messages. */
const SYNC_SPREAD_SECONDS = 21600;

/**
 * Producer: pick subscriptions due for sync and enqueue them.
 *
 * For each subscription, the per-user `sync_interval` (minutes) is read from the
 * `caps:<userId>` KV cache (written by the session middleware on login). When a
 * cap is missing or unparseable, the conservative {@link DEFAULT_SYNC_INTERVAL_MINUTES}
 * default is used. A subscription is due when it has never synced (`lastSyncedAt`
 * null) or `now - lastSyncedAt >= interval`.
 */
export async function enqueueScheduleSync(env: Env): Promise<void> {
  console.log(
    JSON.stringify({ event: "cron.schedule_sync.start", message: "Selecting due subscriptions" }),
  );
  const db = drizzle(env.DB);

  const allSubs = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      lastSyncedAt: subscriptions.lastSyncedAt,
    })
    .from(subscriptions);

  if (allSubs.length === 0) {
    console.log(
      JSON.stringify({ event: "cron.schedule_sync.skip", message: "No subscriptions" }),
    );
    return;
  }

  // Cache sync_interval per user to avoid re-reading KV for each subscription.
  const intervalCache = new Map<string, number>();
  const now = Date.now();
  const due: ScheduleSyncMessage[] = [];

  for (const sub of allSubs) {
    let interval = intervalCache.get(sub.userId);
    if (interval === undefined) {
      interval = await readSyncIntervalMinutes(env, sub.userId);
      intervalCache.set(sub.userId, interval);
    }

    if (isDue(sub.lastSyncedAt, interval, now)) {
      due.push({ subscriptionId: sub.id, userId: sub.userId });
    }
  }

  if (due.length === 0) {
    console.log(
      JSON.stringify({
        event: "cron.schedule_sync.skip",
        total: allSubs.length,
        message: "No subscriptions due",
      }),
    );
    return;
  }

  await spreadEnqueue(
    env.SCHEDULE_SYNC_QUEUE,
    due,
    (m) => ({ body: m }),
    SYNC_SPREAD_SECONDS,
    10,
  );

  console.log(
    JSON.stringify({
      event: "cron.schedule_sync.enqueued",
      count: due.length,
      total: allSubs.length,
      message: `Enqueued ${due.length}/${allSubs.length} due subscriptions`,
    }),
  );
}

/** Read a user's `sync_interval` (minutes) from the caps KV cache, with default fallback. */
async function readSyncIntervalMinutes(env: Env, userId: string): Promise<number> {
  try {
    const caps = await env.CACHE.get(`caps:${userId}`, "json");
    const raw = (caps as { sync_interval?: number | null } | null)?.sync_interval;
    if (typeof raw === "number" && raw > 0) return raw;
  } catch {
    // fall through to default
  }
  return DEFAULT_SYNC_INTERVAL_MINUTES;
}

/** A subscription is due when never synced, or last sync is older than `interval` minutes. */
function isDue(lastSyncedAt: string | null, intervalMinutes: number, now: number): boolean {
  if (!lastSyncedAt) return true;
  const last = Date.parse(lastSyncedAt);
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMinutes * 60_000;
}

/**
 * Consumer: process a batch of per-subscription sync messages.
 *
 * Each message resolves a CQU bearer via {@link getCquBearer} (auth 拓扑①). A
 * null bearer (inactive auth session / exchange failure) is logged and acked —
 * never retried — so an offline user does not block the batch.
 */
export async function processScheduleSyncBatch(
  batch: MessageBatch<ScheduleSyncMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const { subscriptionId, userId } = message.body;
      try {
        const [sub] = await db
          .select({
            id: subscriptions.id,
            sourceType: subscriptions.sourceType,
            sourceId: subscriptions.sourceId,
            sourceName: subscriptions.sourceName,
            sessionId: subscriptions.sessionId,
            sessionName: subscriptions.sessionName,
          })
          .from(subscriptions)
          .where(eq(subscriptions.id, subscriptionId))
          .limit(1);

        if (!sub) {
          // Subscription deleted between enqueue and processing.
          message.ack();
          return;
        }

        const bearer = await getCquBearer(env, userId);
        if (!bearer) {
          console.log(
            JSON.stringify({
              event: "queue.schedule_sync.skip_no_bearer",
              subscriptionId,
              message: "No CQU bearer available; skipping",
            }),
          );
          message.ack();
          return;
        }

        const api = new CQUAPIClient(bearer);
        const ctx = await fetchSessionContextCached(api, env.CACHE);
        const fallback = { sessionId: sub.sessionId, sessionName: sub.sessionName };

        if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
          // Personal subscription: sourceId is the student ID.
          const studentId = sub.sourceId;
          const personalData = await fetchPersonalScheduleCached(
            api,
            studentId,
            ctx,
            env.CACHE,
          );
          const ics = preGenerateIcs(personalData, studentId);
          const result = buildPersonalSyncResult(sub.sourceType, personalData, ics);
          await applySyncResult(db, sub.id, result, ctx, fallback);
        } else {
          // Explore subscription: sourceId is the target ID; use it as the ICS
          // UID namespace (stable per subscription).
          const result = await buildExploreSyncResult(
            api,
            sub.sourceType as ExploreSourceType,
            sub.sourceId,
            sub.sourceId,
            ctx,
          );
          await applySyncResult(db, sub.id, result, ctx, fallback);
        }

        console.log(
          JSON.stringify({
            event: "queue.schedule_sync.subscription_synced",
            subscriptionId,
            sourceType: sub.sourceType,
            message: "Subscription synced",
          }),
        );

        message.ack();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            event: "queue.schedule_sync.failed",
            subscriptionId,
            error: msg,
            message: "Schedule sync failed",
          }),
        );
        message.retry();
      }
    }),
  );
}
