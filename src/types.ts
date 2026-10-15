import type { ScheduleSyncMessage } from "./cron/schedule-sync";
import type { ScheduleNotificationMessageV1 } from "./services/schedule-notifications";

export interface Env {
  // Static Assets
  ASSETS: Fetcher;

  // D1 Database
  DB: D1Database;

  // KV Cache
  CACHE: KVNamespace;

  // Rate Limiting
  UNAUTH_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  EXTERNAL_LIMITER: RateLimit;

  // Queues
  SCHEDULE_SYNC_QUEUE: Queue<ScheduleSyncMessage>;
  SCHEDULE_NOTIFICATION_QUEUE: Queue<ScheduleNotificationMessageV1>;

  // Auth service (拓扑①: Service Binding RPC to cqu-moe-auth)
  AUTH: import("./services/auth-rpc").AuthService;

  // Secrets
  /** OAuth client id of this app's auth client (auth auto-generates it, e.g.
   *  "YKJBemj…"; NOT the literal "calendar"). Used as clientId in AUTH RPC calls. */
  CALENDAR_CLIENT_ID: string;
  /** OAuth client secret for the above client, required by AUTH.getCquTicket /
   *  getCaps (auth verifies the hashed secret over RPC; see ../auth subsystem guide §1.2). */
  CALENDAR_CLIENT_SECRET: string;

  // Environment Variables
  PUBLIC_URL: string;
  /** Comma-separated source allowlist; only implemented sources can be exposed. */
  EXTERNAL_SUBSCRIPTION_TYPES?: string;
  /** Optional comma-separated pilot IDs. Present but empty closes all admission. */
  EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS?: string;
  /** Explicitly consenting Auth user used for the weekly shared directory.
   * Unset disables collection and shared-directory reads. Configure out of Git. */
  EXTERNAL_DIRECTORY_USER_ID?: string;
  AUTH_ORIGIN?: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
  PERSONAL_SUBSCRIPTION_MODE?: "legacy" | "migration" | "enabled";
  /** Dev-only: "1" 时允许在 localhost 且缺少 AUTH binding 的情况下注入 mock auth。 */
  DEV_AUTH_MOCK?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  POSTHOG_ENABLED?: string;
  ENVIRONMENT?: "production" | "preview" | "development" | "test";
  RELEASE?: string;
}
