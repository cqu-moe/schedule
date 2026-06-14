import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import configRoutes from "./routes/config";
import adminRoutes from "./routes/admin";
import { enqueueScheduleSync, processScheduleSyncBatch, type ScheduleSyncMessage } from "./cron/schedule-sync";
import { addSecurityHeaders } from "./middleware/security-headers";
import { rewriteHtmlMeta } from "./middleware/seo";
import { errorResponse } from "./utils/error";
import { createMockAuth } from "./services/auth-mock";
import { sessionMiddleware } from "./middleware/session";
import subscriptionsV2 from "./routes/v2/subscriptions";
import calendarV2 from "./routes/v2/calendar";

const app = new Hono<{ Bindings: Env }>();

// Dev-only: localhost 未配 AUTH service binding 时注入 mock，方便离线开发。
// 生产环境 binding 存在故不触发。
app.use("*", async (c, next) => {
  if (!c.env.AUTH) {
    c.env.AUTH = createMockAuth();
  }
  await next();
});

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
app.route("/api/v1/admin", adminRoutes);

// v2 (拓扑①): session-guarded routes verify the cross-subdomain auth cookie via
// the AUTH service binding before exposing the current user's subscriptions.
app.use("/api/v2/subscriptions/*", sessionMiddleware);
app.use("/api/v2/subscriptions", sessionMiddleware);
app.route("/api/v2/subscriptions", subscriptionsV2);

// v2 public calendar endpoints: addressed by link token, no login required, so
// NOT guarded by sessionMiddleware. Access control is the per-link format gate.
app.route("/api/v2/calendar", calendarV2);

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
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
    } else {
      response = await env.ASSETS.fetch(request);
      try {
        response = rewriteHtmlMeta(response, url.pathname);
      } catch (err) {
        console.error(JSON.stringify({
          event: "middleware.seo.rewrite_error",
          pathname: url.pathname,
          error: err instanceof Error ? err.message : String(err),
          message: "HTMLRewriter failed, serving original response",
        }));
      }
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
      case "schedule-sync":
        await processScheduleSyncBatch(batch as MessageBatch<ScheduleSyncMessage>, env);
        break;
      default:
        console.warn(JSON.stringify({ event: "http.unknown_queue", queue: batch.queue, message: "Unknown queue" }));
    }
  },
} satisfies ExportedHandler<Env>;
