import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import configRoutes from "./routes/config";
import userRoutes from "./routes/users";
import subscriptionRoutes from "./routes/subscriptions";
import exploreRoutes from "./routes/explore";
import { enqueueTokenRefresh, processTokenRefreshBatch, type TokenRefreshMessage } from "./cron/token-refresh";
import { enqueueScheduleSync, processScheduleSyncBatch, type ScheduleSyncMessage } from "./cron/schedule-sync";
import { addSecurityHeaders } from "./middleware/security-headers";
import { rewriteHtmlMeta } from "./middleware/seo";
import { errorResponse } from "./utils/error";

const app = new Hono<{ Bindings: Env }>();

// CORS: restrict to same-origin; allow local dev origins
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      // Allow same-origin (no Origin header) and configured public URL
      const publicUrl = c.env.PUBLIC_URL ?? "";
      if (!origin) return publicUrl || "*";
      if (publicUrl && origin === publicUrl) return origin;
      // Allow schedule.cqu.moe alongside beta
      if (origin === "https://schedule.cqu.moe") return origin;
      // Allow localhost for dev
      if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
        return origin;
      }
      return "";
    },
    allowHeaders: ["Authorization", "Content-Type", "X-Captcha-Token"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

// Mount routes
app.route("/api/v1", configRoutes);
app.route("/api/v1/users", userRoutes);
app.route("/api/v1/subscriptions", subscriptionRoutes);
app.route("/api/v1", exploreRoutes);

// Global error handler
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "http.unhandled_error", error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, message: "Unhandled error" }));
  return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname.startsWith("/api/")) {
      response = await app.fetch(request, env, ctx);
    } else {
      response = await env.ASSETS.fetch(request);
      response = rewriteHtmlMeta(response, url.pathname);
    }
    return addSecurityHeaders(response);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    switch (controller.cron) {
      case "0 * * * *":
        await enqueueTokenRefresh(env);
        break;
      case "0 17 * * *":
        await enqueueScheduleSync(env);
        break;
      default:
        console.warn(JSON.stringify({ event: "http.unknown_cron", cron: controller.cron, message: "Unknown cron schedule" }));
    }
  },
  async queue(
    batch: MessageBatch,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    switch (batch.queue) {
      case "schedule-token-refresh":
        await processTokenRefreshBatch(batch as MessageBatch<TokenRefreshMessage>, env);
        break;
      case "schedule-sync":
        await processScheduleSyncBatch(batch as MessageBatch<ScheduleSyncMessage>, env);
        break;
      default:
        console.warn(JSON.stringify({ event: "http.unknown_queue", queue: batch.queue, message: "Unknown queue" }));
    }
  },
} satisfies ExportedHandler<Env>;
