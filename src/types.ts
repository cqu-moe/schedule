import type { ScheduleSyncMessage } from "./cron/schedule-sync";

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
  EXPLORE_LIMITER: RateLimit;

  // Queues
  SCHEDULE_SYNC_QUEUE: Queue<ScheduleSyncMessage>;

  // Auth service (拓扑①: Service Binding RPC to cqu-moe-auth)
  AUTH: import("./services/auth-rpc").AuthService;

  // Secrets
  ENCRYPTION_KEY: string;
  HCAPTCHA_SECRET: string;
  ADMIN_SECRET: string;

  // Environment Variables
  PUBLIC_URL: string;
  HCAPTCHA_ENABLED: string;
  HCAPTCHA_SITEKEY: string;
  CAPTCHA_FAIL_CLOSED?: string;
  MAX_SUBSCRIPTIONS: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
}
