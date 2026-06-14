import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../types";
import { subscriptions } from "../db/schema";
import { errorResponse } from "../utils/error";
import { spreadEnqueue } from "../utils/queue";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";

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

  const subs = await db
    .select({ id: subscriptions.id, userId: subscriptions.userId })
    .from(subscriptions);

  if (subs.length === 0) {
    console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: 0, message: "No subscriptions" }));
    return c.json({ enqueued: 0 });
  }

  try {
    await spreadEnqueue(
      c.env.SCHEDULE_SYNC_QUEUE,
      subs,
      (s) => ({ body: { subscriptionId: s.id, userId: s.userId } satisfies ScheduleSyncMessage }),
      REFRESH_SPREAD_SECONDS,
      5,
    );
  } catch (e) {
    console.error(JSON.stringify({
      event: "admin.refresh_all.send_failed",
      total: subs.length,
      error: e instanceof Error ? e.message : String(e),
      message: "Failed to enqueue subscriptions for refresh",
    }));
    return c.json({ enqueued: 0, error: `Failed to enqueue ${subs.length} subscriptions` }, 500);
  }

  console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: subs.length, message: `Enqueued ${subs.length} subscriptions for sync` }));
  return c.json({ enqueued: subs.length });
});

export default app;
