import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import type {
  MeResponse,
  SubscriptionList,
  Subscription,
  CalendarLink,
  CreateLinkBody,
  PatchLinkBody,
  RotateLinkResult,
  ExternalSearchResponse,
  ExternalSession,
  DepartmentNode,
  AppConfig,
  CalendarData,
  SyncQueuedResponse,
  NotificationSettings,
  DefaultSubscriptionsResponse,
} from '@/types/api'
import { signedOutUrl } from '@/config/auth'

// Augment axios config to support per-request auth-redirect suppression.
declare module 'axios' {
  interface AxiosRequestConfig<D = any, P = any> {
    /** When true, a 401 response will NOT trigger a redirect to the login page. */
    suppressAuthRedirect?: boolean
  }
}

const client = axios.create({
  baseURL: '/api/v2',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

/**
 * Mutable redirect seam — extracted so tests can replace `.fn` with a spy and
 * assert the exact URL the 401 interceptor passes, without touching
 * window.location.href (non-configurable in jsdom).
 *
 * @example (test)
 *   import { redirect } from '@/api'
 *   redirect.fn = vi.fn()
 *   // … trigger 401 …
 *   expect(redirect.fn).toHaveBeenCalledWith('/signed-out?returnTo=...')
 *   redirect.fn = (url) => { window.location.href = url } // restore
 */
export const redirect = {
  fn: (url: string) => {
    window.location.href = url
  },
}

// 429 interceptor: normalise into the standard { detail: "..." } shape.
// 401 interceptor: show a signed-out page with an explicit login action, unless:
//   - suppressAuthRedirect is set on the request config (e.g. getMe probe), OR
//   - the error code is TOKEN_EXPIRED (upstream CQU bearer expired; schedule session is still
//     valid — the backend already invalidated the bearer and will re-mint on the next request,
//     so we must NOT redirect the user to the login page).
client.interceptors.response.use(undefined, (error: AxiosError) => {
  if (error.response?.status === 401) {
    const data = error.response.data as Record<string, unknown> | undefined
    const errorCode = (data?.detail as Record<string, unknown> | undefined)?.error as
      | Record<string, unknown>
      | undefined
    const isUpstreamTokenExpired = (errorCode?.code as string | undefined) === 'TOKEN_EXPIRED'

    if (
      !isUpstreamTokenExpired &&
      !(error.config as InternalAxiosRequestConfig)?.suppressAuthRedirect
    ) {
      redirect.fn(signedOutUrl(window.location.href))
    }
    return Promise.reject(error)
  }

  if (
    error.response?.status === 429 &&
    !(error.response?.data as Record<string, unknown>)?.detail
  ) {
    ;(error.response!.data as Record<string, unknown>) = {
      detail: '操作过于频繁，请稍后再试',
    }
  }
  return Promise.reject(error)
})

export default {
  // ── Session ────────────────────────────────────────────────────────────────

  async getMe(): Promise<MeResponse> {
    const response = await client.get<MeResponse>('/me', { suppressAuthRedirect: true })
    return response.data
  },

  async getNotificationSettings(): Promise<NotificationSettings> {
    const response = await client.get<NotificationSettings>('/notification-settings')
    return response.data
  },

  async updateNotificationSettings(enabled: boolean): Promise<NotificationSettings> {
    const response = await client.put<NotificationSettings>('/notification-settings', { enabled })
    return response.data
  },

  // ── Subscriptions ─────────────────────────────────────────────────────────

  async getSubscriptions(noCache = false): Promise<SubscriptionList> {
    const headers: Record<string, string> = {}
    if (noCache) headers['Cache-Control'] = 'no-cache'
    const response = await client.get<SubscriptionList>('/subscriptions', { headers })
    return response.data
  },

  async ensureDefaultSubscriptions(): Promise<DefaultSubscriptionsResponse> {
    const response = await client.post<DefaultSubscriptionsResponse>('/subscriptions/defaults')
    return response.data
  },

  async getSubscription(sid: string): Promise<Subscription> {
    const response = await client.get<Subscription>(`/subscriptions/${sid}`)
    return response.data
  },

  async createSubscription(body: {
    sourceType: string
    sourceId?: string
    sourceName: string
    sessionId?: string
    sessionName?: string
    semesterStart?: string
    isPersonal?: boolean
  }): Promise<Subscription> {
    const response = await client.post<Subscription>('/subscriptions', body, { timeout: 120000 })
    return response.data
  },

  async deleteSubscription(sid: string): Promise<void> {
    await client.delete(`/subscriptions/${sid}`)
  },

  /** POST /:sid/syncs — manual refresh (202 Accepted). */
  async refreshSubscription(sid: string): Promise<SyncQueuedResponse> {
    const response = await client.post<SyncQueuedResponse>(`/subscriptions/${sid}/syncs`, null)
    return response.data
  },

  async refreshPersonalSubscription(): Promise<SyncQueuedResponse> {
    const response = await client.post<SyncQueuedResponse>('/subscriptions/personal/syncs', null)
    return response.data
  },

  // ── Calendar links ────────────────────────────────────────────────────────

  async getLinks(sid: string): Promise<{ links: CalendarLink[]; count: number }> {
    const response = await client.get<{ links: CalendarLink[]; count: number }>(
      `/subscriptions/${sid}/links`,
    )
    return response.data
  },

  async createLink(sid: string, body: CreateLinkBody): Promise<CalendarLink> {
    const response = await client.post<CalendarLink>(`/subscriptions/${sid}/links`, body)
    return response.data
  },

  async patchLink(sid: string, lid: string, body: PatchLinkBody): Promise<CalendarLink> {
    const response = await client.patch<CalendarLink>(`/subscriptions/${sid}/links/${lid}`, body)
    return response.data
  },

  async deleteLink(sid: string, lid: string): Promise<void> {
    await client.delete(`/subscriptions/${sid}/links/${lid}`)
  },

  async rotateLink(sid: string, lid: string): Promise<RotateLinkResult> {
    const response = await client.post<RotateLinkResult>(
      `/subscriptions/${sid}/links/${lid}/rotations`,
      null,
    )
    return response.data
  },

  // ── External search ───────────────────────────────────────────────────────

  async searchExternal(params: {
    source_type: string
    keyword: string
    department_id?: string
    grade?: string
  }): Promise<ExternalSearchResponse> {
    const query = new URLSearchParams({ source_type: params.source_type, keyword: params.keyword })
    if (params.department_id) query.append('department_id', params.department_id)
    if (params.grade) query.append('grade', params.grade)
    const response = await client.get<ExternalSearchResponse>(`/external/search?${query}`, { timeout: 100_000 })
    return response.data
  },

  async getDepartments(): Promise<{ session: ExternalSession; departments: DepartmentNode[] }> {
    const response = await client.get<{ session: ExternalSession; departments: DepartmentNode[] }>('/external/departments', { timeout: 100_000 })
    return response.data
  },

  // ── Public calendar view (no auth; uses the public /api/v2/calendar/ path) ─

  /** GET /api/v2/calendar/:token/view.json — used by the /view page (FE-4). */
  async getViewData(token: string): Promise<CalendarData> {
    const response = await client.get<CalendarData>(
      `/calendar/${encodeURIComponent(token)}/view.json`,
      { suppressAuthRedirect: true },
    )
    return response.data
  },

  // ── Config ─────────────────────────────────────────────────────────────────

  async getConfig(): Promise<AppConfig> {
    const response = await client.get<AppConfig>('/config')
    return response.data
  },
}
