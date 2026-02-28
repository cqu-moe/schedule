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
  TOKEN_REFRESH_QUEUE: Queue;
  SCHEDULE_SYNC_QUEUE: Queue;

  // Secrets
  ENCRYPTION_KEY: string;
  HCAPTCHA_SECRET: string;

  // Environment Variables
  PUBLIC_URL: string;
  HCAPTCHA_ENABLED: string;
  HCAPTCHA_SITEKEY: string;
  MAX_SUBSCRIPTIONS: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
}
