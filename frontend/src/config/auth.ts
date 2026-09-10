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

export function scheduleSetupTarget(returnTo: string): string {
  const target = new URL(returnTo)
  if (target.pathname === '/') target.pathname = '/dashboard'
  target.searchParams.set('setup', '1')
  return target.toString()
}

export function authCquBindUrl(
  returnTo: string,
  options: { repair?: boolean } = {},
): string {
  const binding = new URL('/cqu/bind', AUTH_BASE_URL)
  binding.searchParams.set('redirect', scheduleSetupTarget(returnTo))
  if (options.repair) binding.searchParams.set('repair', '1')
  return binding.toString()
}
