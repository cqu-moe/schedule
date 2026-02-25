export interface Env {
  // D1 Database
  DB: D1Database;

  // Rate Limiting
  UNAUTH_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  EXPLORE_LIMITER: RateLimit;

  // Secrets
  ENCRYPTION_KEY: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  HCAPTCHA_SECRET: string;

  // Environment Variables
  PUBLIC_URL: string;
  PLAYWRIGHT_URL: string;
  HCAPTCHA_ENABLED: string;
  HCAPTCHA_SITEKEY: string;
  MAX_SUBSCRIPTIONS: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
}
