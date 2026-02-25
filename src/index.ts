import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import configRoutes from "./routes/config";
import userRoutes from "./routes/users";
import subscriptionRoutes from "./routes/subscriptions";
import exploreRoutes from "./routes/explore";
import { refreshExpiringTokens } from "./cron/token-refresh";
import { syncAllSubscriptions } from "./cron/schedule-sync";

const app = new Hono<{ Bindings: Env }>();

// CORS (same-origin in production, but useful for local dev)
app.use("/api/*", cors());

// Mount routes
app.route("/api/v1", configRoutes);
app.route("/api/v1/users", userRoutes);
app.route("/api/v1/subscriptions", subscriptionRoutes);
app.route("/api/v1", exploreRoutes);

// Global error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ detail: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    switch (controller.cron) {
      case "0 */3 * * *":
        ctx.waitUntil(refreshExpiringTokens(env));
        break;
      case "0 19 * * *":
        ctx.waitUntil(syncAllSubscriptions(env));
        break;
      default:
        console.log(`cron: unknown schedule ${controller.cron}`);
    }
  },
};
