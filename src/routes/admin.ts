import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../types";
import { subscriptions } from "../db/schema";
import { eq } from "drizzle-orm";
import { errorResponse } from "../utils/error";
import { spreadEnqueue, SpreadEnqueueError } from "../utils/queue";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";
import { personalSubscriptionMode } from "../config/personal-subscription-mode";
import { claimSubscriptionRun, markSyncError } from "../services/sync-status";

/** Spread window (seconds) for the admin-triggered full refresh. */
const REFRESH_SPREAD_SECONDS = 3600;

const app = new Hono<{ Bindings: Env }>();

// Admin auth middleware
app.use("/*", async (c, next) => {
  const secret = c.env.ADMIN_SECRET;
  const auth = c.req.header("Authorization");
  if (!secret || !auth) {
    return errorResponse("UNAUTHORIZED", "Invalid or missing admin secret", 401);
  }
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  const actual = new TextEncoder().encode(auth);
  if (expected.byteLength !== actual.byteLength ||
      !crypto.subtle.timingSafeEqual(expected, actual)) {
    return errorResponse("UNAUTHORIZED", "Invalid or missing admin secret", 401);
  }
  await next();
});

// POST /refresh-all — enqueue a sync for every subscription.
app.post("/refresh-all", async (c) => {
  const db = drizzle(c.env.DB);
  const mode = personalSubscriptionMode(c.env);
  if (mode === "migration") {
    return errorResponse(
      "PERSONAL_SUBSCRIPTION_MIGRATING",
      "个人课表正在维护，请稍后重试",
      503,
    );
  }

  const subs = await db
    .select({ id: subscriptions.id, userId: subscriptions.userId })
    .from(subscriptions)
    .where(mode === "enabled" ? eq(subscriptions.sourceType, "personal") : undefined);

  const messages: ScheduleSyncMessage[] = [];
  if (mode === "enabled") {
    const now = new Date().toISOString();
    for (const sub of subs) {
      const claim = await claimSubscriptionRun(c.env.DB, sub.id, "admin", now);
      if (claim.kind === "accepted") {
        messages.push({
          subscriptionId: sub.id,
          userId: sub.userId,
          runId: claim.runId,
          trigger: "admin",
        });
      }
    }
  } else {
    messages.push(...subs.map((sub) => ({
      subscriptionId: sub.id,
      userId: sub.userId,
    })));
  }

  if (messages.length === 0) {
    console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: 0, message: "No subscriptions" }));
    return c.json({ enqueued: 0 });
  }

  let enqueued: number;
  try {
    enqueued = await spreadEnqueue(
      c.env.SCHEDULE_SYNC_QUEUE,
      messages,
      (message) => ({ body: message }),
      REFRESH_SPREAD_SECONDS,
      5,
    );
  } catch (e) {
    // Report how many were actually enqueued before the failure — admin messages
    // have no cron trigger (consumer can't dedup), so a retry after a falsely
    // reported "0" would duplicate the already-queued syncs.
    const partial = e instanceof SpreadEnqueueError ? e.enqueued : 0;
    if (mode === "enabled") {
      await Promise.all(messages.slice(partial).map((message) =>
        markSyncError(db, message.subscriptionId, message.runId!, {
          code: "QUEUE_UNAVAILABLE",
          message: "同步服务暂时不可用，请稍后重试",
        })));
    }
    console.error(JSON.stringify({
      event: "admin.refresh_all.send_failed",
      total: messages.length,
      enqueued: partial,
      error: e instanceof Error ? e.message : String(e),
      message: "Failed to enqueue all subscriptions for refresh",
    }));
    return c.json(
      { enqueued: partial, error: `Failed after enqueuing ${partial}/${messages.length} subscriptions` },
      500,
    );
  }

  if (mode === "enabled" && enqueued < messages.length) {
    await Promise.all(messages.slice(enqueued).map((message) =>
      markSyncError(db, message.subscriptionId, message.runId!, {
        code: "QUEUE_UNAVAILABLE",
        message: "同步服务暂时不可用，请稍后重试",
      })));
  }
  console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: enqueued, message: `Enqueued ${enqueued} subscriptions for sync` }));
  return c.json({ enqueued });
});

export default app;
