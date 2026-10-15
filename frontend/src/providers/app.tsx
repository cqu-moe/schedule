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
  ExternalAvailability,
  CquBindStatus,
  MeResponse,
  SessionUser,
} from '@/types/api'
import { captureScheduleEvent, syncPostHogIdentity } from '@/lib/posthog'
import { apiErrorCode } from '@/utils/error'

interface SessionState {
  externalAvailability: ExternalAvailability
  user: SessionUser | null
  caps: CalendarCaps | null
  /** undefined = 旧版 auth 未下发（未知）；只有明确的非 active 值才能触发绑定引导。 */
  cquBindStatus: CquBindStatus | undefined
}

export interface AppContextValue extends SessionState {
  sessionPending: boolean
  /** Absent after a successful read; transient failures do not invalidate a confirmed session. */
  sessionError?: 'unauthenticated' | 'unavailable'
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
  externalAvailability: { search_types: [], create_types: [] },
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
  const [sessionPending, setSessionPending] = useState(true)
  const [sessionError, setSessionError] = useState<AppContextValue['sessionError']>()
  const hasSession = useRef(false)
  const loadPromise = useRef<Promise<MeResponse> | null>(null)
  const sessionReadyReported = useRef(false)

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
    if (!hasSession.current) setSessionPending(true)
    setSessionError(undefined)
    const request = (async (): Promise<MeResponse> => {
      try {
        const data = await api.getMe()
        hasSession.current = true
        syncPostHogIdentity(data.user.id)
        setSession({
          externalAvailability: data.external ?? EMPTY_SESSION.externalAvailability,
          user: data.user,
          caps: data.caps.calendar,
          cquBindStatus: data.cquBindStatus,
        })
        if (!sessionReadyReported.current) {
          sessionReadyReported.current = true
          captureScheduleEvent('app_session_ready', {
            actor_type: 'user',
            trigger: 'automatic',
            operation: 'session_ready',
            outcome: 'success',
          })
        }
        return data
      } catch (error) {
        const unauthorized = (error as { response?: { status?: number } })?.response?.status === 401
          && apiErrorCode(error) !== 'TOKEN_EXPIRED'
        setSessionError(unauthorized ? 'unauthenticated' : 'unavailable')
        if (unauthorized || !hasSession.current) {
          hasSession.current = false
          syncPostHogIdentity(null)
          setSession(EMPTY_SESSION)
        }
        throw error
      } finally {
        setSessionPending(false)
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
      sessionPending,
      sessionError,
      publicUrl,
      isAuthenticated: session.user !== null,
      isCquBound: session.cquBindStatus === 'active',
      isCquUnbound:
        session.cquBindStatus !== undefined && session.cquBindStatus !== 'active',
      can: (flag) => Boolean(session.caps?.[flag]),
      quota: (key) => session.caps?.[key] ?? null,
      reloadSession,
    }),
    [session, sessionPending, sessionError, publicUrl, reloadSession],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useSession(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useSession must be used within AppProvider')
  return context
}
