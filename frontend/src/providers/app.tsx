import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import api from '@/api'
import type {
  CalendarCaps,
  CquBindStatus,
  MeResponse,
  SessionUser,
} from '@/types/api'
import { syncPostHogIdentity } from '@/lib/posthog'

interface SessionState {
  user: SessionUser | null
  caps: CalendarCaps | null
  /** undefined = 旧版 auth 未下发（未知）；只有明确的非 active 值才能触发绑定引导。 */
  cquBindStatus: CquBindStatus | undefined
}

export interface AppContextValue extends SessionState {
  publicUrl: string
  isAuthenticated: boolean
  /** True 仅在明确知道用户已绑定时；未知（undefined）按未绑定处理会误伤旧 auth。 */
  isCquBound: boolean
  /** True 仅在明确知道用户未绑定时（pending/revoked/unbound）；未知不算。 */
  isCquUnbound: boolean
  can: (flag: 'sync' | 'external' | 'share' | 'change_notification') => boolean
  quota: (
    key: 'sub_limit' | 'share_limit' | 'sync_interval' | 'manual_refresh',
  ) => number | null
  /** Reloads /me and resolves with the fresh response (context also updates). */
  reloadSession: () => Promise<MeResponse>
}

export const AppContext = createContext<AppContextValue | null>(null)

const EMPTY_SESSION: SessionState = {
  user: null,
  caps: null,
  cquBindStatus: undefined,
}

/**
 * Loads backend config (public_url) and session (user/caps) once on startup.
 * getMe uses suppressAuthRedirect so 401 (unauthenticated visitors) is silently
 * swallowed here — public routes remain accessible. Protected pages trigger
 * their own authenticated API calls whose 401s still redirect via the interceptor.
 */
export function AppProvider({ children }: { children: ReactNode }) {
  const [publicUrl, setPublicUrl] = useState(window.location.origin)
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION)
  const loadPromise = useRef<Promise<MeResponse> | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getConfig()
      .then((data) => {
        if (!cancelled) setPublicUrl(data.public_url)
      })
      .catch(() => {
        // Fallback to origin; config is non-critical.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const reloadSession = useCallback((): Promise<MeResponse> => {
    if (loadPromise.current) return loadPromise.current
    const request = (async (): Promise<MeResponse> => {
      try {
        const data = await api.getMe()
        syncPostHogIdentity(data.user.id)
        setSession({
          user: data.user,
          caps: data.caps.calendar,
          cquBindStatus: data.cquBindStatus,
        })
        return data
      } finally {
        loadPromise.current = null
      }
    })()
    loadPromise.current = request
    return request
  }, [])

  useEffect(() => {
    // On 401, the axios interceptor redirect is suppressed for getMe; the
    // rejection is swallowed here — unauthenticated visitors stay on public pages.
    void reloadSession().catch(() => {})
  }, [reloadSession])

  const value = useMemo<AppContextValue>(
    () => ({
      ...session,
      publicUrl,
      isAuthenticated: session.user !== null,
      isCquBound: session.cquBindStatus === 'active',
      isCquUnbound:
        session.cquBindStatus !== undefined && session.cquBindStatus !== 'active',
      can: (flag) => Boolean(session.caps?.[flag]),
      quota: (key) => session.caps?.[key] ?? null,
      reloadSession,
    }),
    [session, publicUrl, reloadSession],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useSession(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useSession must be used within AppProvider')
  return context
}
