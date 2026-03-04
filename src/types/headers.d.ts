// getSetCookie() is available in Workers runtime but missing from default @cloudflare/workers-types
interface Headers {
  getSetCookie(): string[];
}
