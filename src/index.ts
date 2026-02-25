import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "./types";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Health check endpoint
app.get("/api/v1/health", (c) => {
  return c.json({
    status: "ok",
    commit: c.env.GIT_COMMIT ?? "dev",
    date: c.env.GIT_DATE ?? "unknown",
  });
});

export default {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    switch (controller.cron) {
      case "0 */3 * * *":
        // Token refresh — implemented in a later task
        console.log("cron: token refresh triggered");
        break;
      case "0 19 * * *":
        // Schedule sync — implemented in a later task
        console.log("cron: schedule sync triggered");
        break;
      default:
        console.log(`cron: unknown schedule ${controller.cron}`);
    }
  },
};
