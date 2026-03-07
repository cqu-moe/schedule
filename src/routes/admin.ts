import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { isNotNull } from "drizzle-orm";
import type { Env } from "../types";
import { users } from "../db/schema";
import { errorResponse } from "../utils/error";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";

const BATCH_SIZE = 100;

const app = new Hono<{ Bindings: Env }>();

// Admin auth middleware
app.use("/*", async (c, next) => {
  const secret = c.env.ADMIN_SECRET;
  const auth = c.req.header("Authorization");
  if (!secret || !auth || auth !== `Bearer ${secret}`) {
    return errorResponse("UNAUTHORIZED", "Invalid or missing admin secret", 401);
  }
  await next();
});

// POST /refresh-all
app.post("/refresh-all", async (c) => {
  const db = drizzle(c.env.DB);

  const activeUsers = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: 0, message: "No active users" }));
    return c.json({ enqueued: 0 });
  }

  // Enqueue all users with no delay, batched by 100
  for (let i = 0; i < activeUsers.length; i += BATCH_SIZE) {
    const chunk = activeUsers.slice(i, i + BATCH_SIZE);
    await c.env.SCHEDULE_SYNC_QUEUE.sendBatch(
      chunk.map((u) => ({
        body: { userId: u.id, studentId: u.studentId } satisfies ScheduleSyncMessage,
      })),
    );
  }

  console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: activeUsers.length, message: `Enqueued ${activeUsers.length} users for immediate sync` }));
  return c.json({ enqueued: activeUsers.length });
});

export default app;
