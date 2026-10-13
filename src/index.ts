import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import applicationAuth, { completeLogin } from "./routes/application-auth";
import configRoutes from "./routes/config";
import { enqueueScheduleSync, processScheduleSyncBatch, type ScheduleSyncMessage } from "./cron/schedule-sync";
import { addSecurityHeaders } from "./middleware/security-headers";
import { rateLimit } from "./middleware/rate-limit";
import { rewriteHtmlMeta } from "./middleware/seo";
import { errorResponse } from "./utils/error";
import { createMockAuth } from "./services/auth-mock";
import { sessionMiddleware } from "./middleware/session";
import meV2 from "./routes/v2/me";
import subscriptionsV2 from "./routes/v2/subscriptions";
import externalV2 from "./routes/v2/external";
import calendarV2 from "./routes/v2/calendar";
import notificationSettingsV2 from "./routes/v2/notification-settings";
import { captureScheduleException } from "./lib/posthog";
import { postHogCookieResetResponse } from "./lib/posthog-cookie";

export const app = new Hono<{ Bindings: Env }>();

// Dev-only: 未配 AUTH service binding 时，仅当显式设置 DEV_AUTH_MOCK=1 且请求
// 来自 localhost 才注入 mock（hostname 只是双保险，真正的开关是环境变量，
// 不设置它则任何 hostname 都 fail-closed，不依赖 Host 头派生判断）。
// 生产环境 binding 必然存在；若缺失则属配置错误，必须 fail-closed 返回 500，
// 绝不能把 mock 当成真用户放行（否则等于认证绕过：所有请求都成了固定 dev 用户）。
app.use("*", async (c, next) => {
  if (!c.env.AUTH) {
    const hostname = new URL(c.req.url).hostname;
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    if (c.env.DEV_AUTH_MOCK !== "1" || !isLocal) {
      console.error(JSON.stringify({
        event: "auth.binding_missing",
        hostname,
        message: "AUTH service binding missing and dev mock not enabled (requires DEV_AUTH_MOCK=1 and local host); failing closed",
      }));
      return errorResponse("INTERNAL_ERROR", "认证服务暂不可用", 500);
    }
    c.env.AUTH = createMockAuth();
  }
  await next();
});

/**
 * CORS origin policy, shared by the /api/* cors middleware and the
 * side-effectful telemetry reset route so the two can never drift (#96).
 * Returns null for disallowed origins.
 */
function allowOrigin(origin: string | undefined, env: Env): string | null {
  const publicUrl = env.PUBLIC_URL ?? "";
  if (!origin) return publicUrl || "*";
  if (publicUrl && origin === publicUrl) return origin;
  // Allow schedule.cqu.moe alongside beta
  if (origin === "https://schedule.cqu.moe") return origin;
  // Allow localhost for dev only — production must never echo a local origin
  // (#90: localhost CORS was allowed in every environment).
  if (
    env.ENVIRONMENT !== "production" &&
    (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))
  ) {
    return origin;
  }
  return null;
}

// CORS: restrict to same-origin; allow local dev origins
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => allowOrigin(origin, c.env) ?? "",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// #96: telemetry reset clears the visitor's PostHog cookie on a bare GET, so
// unlike other public GETs it must not be triggerable cross-site. hono/cors
// only decorates responses — it never blocks the request — so the route itself
// applies the shared allowOrigin policy and rejects disallowed origins. It is
// registered after the cors middleware to keep header behavior uniform.
app.get("/api/v2/telemetry/reset", (c) => {
  if (allowOrigin(c.req.header("Origin"), c.env) === null) {
    return errorResponse("FORBIDDEN", "Cross-origin request rejected", 403);
  }
  return postHogCookieResetResponse(c.env.POSTHOG_PROJECT_TOKEN);
});

// Mount routes (v2 topology①: everything lives under /api/v2; /api/v1 is gone).
// config (health + config) is public.
app.route("/api/v2", configRoutes);
app.use("/api/v2/auth/*", rateLimit("AUTH_LIMITER"));
app.route("/api/v2/auth", applicationAuth);
app.get("/callback", rateLimit("AUTH_LIMITER"), completeLogin);

// v2: session-guarded routes verify the local application cookie and current
// central OAuth authority before exposing the current user's subscriptions.
// AUTH_LIMITER (per-IP) runs BEFORE sessionMiddleware so rate-limited requests
// never spend an AUTH RPC / KV / D1 / queue round-trip. External routes keep
// their stricter per-route EXTERNAL_LIMITER instead.
app.use("/api/v2/me", rateLimit("AUTH_LIMITER"), sessionMiddleware);
app.route("/api/v2/me", meV2);

app.use("/api/v2/subscriptions/*", rateLimit("AUTH_LIMITER"), sessionMiddleware);
app.use("/api/v2/subscriptions", rateLimit("AUTH_LIMITER"), sessionMiddleware);
app.route("/api/v2/subscriptions", subscriptionsV2);

app.use("/api/v2/notification-settings", rateLimit("AUTH_LIMITER"), sessionMiddleware);
app.route("/api/v2/notification-settings", notificationSettingsV2);

// EXTERNAL_LIMITER runs BEFORE sessionMiddleware so flood traffic is rejected
// without spending an AUTH.verifySession RPC / caps KV write (stricter than
// AUTH_LIMITER; the external routes hit CQU directly). Owned by the mount here —
// the external sub-app no longer carries its own per-route limiter.
app.use("/api/v2/external/*", rateLimit("EXTERNAL_LIMITER"), sessionMiddleware);
app.use("/api/v2/external", rateLimit("EXTERNAL_LIMITER"), sessionMiddleware);
app.route("/api/v2/external", externalV2);

// v2 public calendar endpoints: addressed by link token, no login required, so
// NOT guarded by sessionMiddleware. Access control is the per-link format gate.
app.route("/api/v2/calendar", calendarV2);

// v1 is fully retired (拓扑① rebuild). Any stale frontend hitting /api/v1/* gets
// a 410 telling it to refresh. Defined after v2 mounts so it never shadows them.
app.all("/api/v1/*", (c) => errorResponse("GONE", "接口已升级，请刷新页面", 410));

// Global error handler
app.onError((err, c) => {
  captureScheduleException(c.env, c.executionCtx, err, {
    component: "http",
    method: c.req.method,
    route: c.req.routePath || new URL(c.req.url).pathname,
  });
  console.error(JSON.stringify({ event: "http.unhandled_error", error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, message: "Unhandled error" }));
  return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname.startsWith("/api/") || url.pathname === "/callback") {
      response = await app.fetch(request, env, ctx);
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
    } else {
      // Non-/api/ paths other than the OAuth callback (including /view/:token) use
      // ASSETS; wrangler's not_found_handling: "single-page-application" returns
      // index.html for client-side routes. No server-side special-casing needed.
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
      case "*/15 * * * *":
        await enqueueScheduleSync(env, ctx);
        break;
      default:
        console.warn(JSON.stringify({ event: "http.unknown_cron", cron: controller.cron, message: "Unknown cron schedule" }));
    }
  },
  async queue(
    batch: MessageBatch,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    switch (batch.queue) {
      case "schedule-sync":
        await processScheduleSyncBatch(batch as MessageBatch<ScheduleSyncMessage>, env, ctx);
        break;
      default:
        console.warn(JSON.stringify({ event: "http.unknown_queue", queue: batch.queue, message: "Unknown queue" }));
    }
  },
} satisfies ExportedHandler<Env>;
