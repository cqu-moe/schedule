/** Single source of truth for the auth service base URL. */
export const AUTH_BASE_URL = 'https://auth.cqu.moe'

/** Login is initiated by this application's backend; long-lived tokens never enter the browser. */
export function authLoginUrl(redirectTo: string): string {
  const target = new URL(redirectTo)
  const returnTo = target.pathname === '/signed-out' ? '/dashboard' : target.pathname + target.search + target.hash
  return `/api/v2/auth/login?returnTo=${encodeURIComponent(returnTo)}`
}

export function signedOutUrl(redirectTo: string): string {
  const target = new URL(redirectTo)
  return `/signed-out?returnTo=${encodeURIComponent(target.pathname + target.search + target.hash)}`
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
