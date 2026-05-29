import type { TokenRefreshMessage } from "./cron/token-refresh";
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
  TOKEN_REFRESH_QUEUE: Queue<TokenRefreshMessage>;
  SCHEDULE_SYNC_QUEUE: Queue<ScheduleSyncMessage>;

  // Secrets
  ENCRYPTION_KEY: string;
  HCAPTCHA_SECRET: string;
  ADMIN_SECRET: string;

  // OAuth (auth.cqu.moe) secrets
  AUTH_OAUTH_CLIENT_ID: string;
  AUTH_OAUTH_CLIENT_SECRET: string;
  OAUTH_STATE_KEY: string; // base64, 独立于 ENCRYPTION_KEY

  // Environment Variables
  PUBLIC_URL: string;
  HCAPTCHA_ENABLED: string;
  HCAPTCHA_SITEKEY: string;
  CAPTCHA_FAIL_CLOSED?: string;
  MAX_SUBSCRIPTIONS: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
}
