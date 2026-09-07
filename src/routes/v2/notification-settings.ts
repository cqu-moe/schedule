import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { notificationState } from "../../db/schema";
import type { SessionEnv } from "../../middleware/session";
import { errorResponse } from "../../utils/error";

const app = new Hono<SessionEnv>();

app.get("/", async (c) => {
  const userId = c.get("user").id;
  const row = await drizzle(c.env.DB)
    .select({ enabled: notificationState.enabled })
    .from(notificationState)
    .where(eq(notificationState.userId, userId))
    .get();
  return c.json({
    eligible: c.get("caps").calendar.change_notification === true,
    enabled: row?.enabled === true,
  });
});

app.put("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("BAD_REQUEST", "请求格式不正确", 400);
  }
  if (!body || typeof body !== "object" || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
    return errorResponse("BAD_REQUEST", "enabled 必须是布尔值", 400);
  }

  const enabled = (body as { enabled: boolean }).enabled;
  const eligible = c.get("caps").calendar.change_notification === true;
  if (enabled && !eligible) {
    return errorResponse("FEATURE_NOT_ENABLED", "课表变更通知未开通", 403);
  }

  const userId = c.get("user").id;
  const now = new Date().toISOString();
  await drizzle(c.env.DB)
    .insert(notificationState)
    .values({ userId, enabled, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: notificationState.userId,
      set: { enabled, updatedAt: now },
    });

  return c.json({ eligible, enabled });
});

export default app;
