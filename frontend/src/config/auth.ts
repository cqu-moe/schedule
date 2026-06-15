/** Single source of truth for the auth service base URL. */
export const AUTH_BASE_URL = 'https://auth.cqu.moe'

/**
 * Builds a full auth login URL that redirects back to the given URL after
 * successful authentication.
 *
 * @example
 *   authLoginUrl(window.location.href)
 *   // → "https://auth.cqu.moe/login?redirect=https%3A%2F%2F..."
 */
export function authLoginUrl(redirectTo: string): string {
  return `${AUTH_BASE_URL}/login?redirect=${encodeURIComponent(redirectTo)}`
}
