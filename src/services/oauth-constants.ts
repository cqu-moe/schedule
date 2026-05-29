export const AUTH_BASE = "https://auth.cqu.moe";
export const OAUTH_SCOPE = "openid offline_access cqu:ticket:jwxt";
export const OAUTH_TX_COOKIE = "oauth_tx";
export const OAUTH_TX_TTL_MS = 600_000; // 10 min,对齐 auth code 有效期
export const OAUTH_COOKIE_PATH = "/api/v1/auth/oauth";

/** 请求 host → SPA/redirect origin 的精确映射。查不到 → null → 调用方返回 400 */
const HOST_ORIGIN_MAP: Record<string, string> = {
  "schedule.cqu.moe": "https://schedule.cqu.moe",
  "schedule-beta.cqu.moe": "https://schedule-beta.cqu.moe",
  "localhost:8787": "http://localhost:8787",
};

export function resolveOrigin(requestUrl: string): string | null {
  const host = new URL(requestUrl).host; // 精确 host(含端口),非子串
  return HOST_ORIGIN_MAP[host] ?? null;
}
