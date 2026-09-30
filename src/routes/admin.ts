import { Hono } from "hono";
import type { Env } from "../types";
import { errorResponse } from "../utils/error";
import { personalSubscriptionMode } from "../config/personal-subscription-mode";
import { runPersonalMigration } from "../services/personal-subscription-migration";

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

app.post("/personal-subscription-migration", async (c) => {
  let body: Record<string, unknown> = {};
  const rawBody = await c.req.text();
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return errorResponse("INVALID_INPUT", "Invalid JSON body", 400);
    }
  }
  const mode = body.mode ?? "dry_run";
  const limit = body.limit ?? 10;
  const cursor = body.after_user_id ?? null;
  if (mode !== "dry_run" && mode !== "apply" && mode !== "verify") {
    return errorResponse("INVALID_INPUT", "mode must be dry_run, apply, or verify", 400);
  }
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 10) {
    return errorResponse("INVALID_INPUT", "limit must be an integer from 1 to 10", 400);
  }
  if (cursor !== null && typeof cursor !== "string") {
    return errorResponse("INVALID_INPUT", "after_user_id must be a string or null", 400);
  }
  if (mode === "apply" && personalSubscriptionMode(c.env) !== "migration") {
    return errorResponse(
      "PERSONAL_MIGRATION_MODE_REQUIRED",
      "Apply requires PERSONAL_SUBSCRIPTION_MODE=migration",
      409,
    );
  }
  try {
    return c.json(await runPersonalMigration(c.env, {
      mode,
      limit: limit as number,
      after_user_id: cursor,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "admin.personal_subscription_migration.failed",
      mode,
      cursor,
      error: error instanceof Error ? error.message : String(error),
    }));
    return errorResponse("PERSONAL_MIGRATION_FAILED", "Personal migration failed", 500);
  }
});

export default app;
