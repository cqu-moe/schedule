import axios, { type AxiosError } from 'axios'
import type {
  MeResponse,
  SubscriptionList,
  Subscription,
  CalendarLink,
  CreateLinkBody,
  PatchLinkBody,
  RotateLinkResult,
  SearchResult,
  DepartmentNode,
  AppConfig,
  HealthStatus,
  CalendarData,
} from '@/types/api'
import { authLoginUrl } from '@/config/auth'

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
 *   expect(redirect.fn).toHaveBeenCalledWith('https://auth.cqu.moe/login?redirect=...')
 *   redirect.fn = (url) => { window.location.href = url } // restore
 */
export const redirect = {
  fn: (url: string) => {
    window.location.href = url
  },
}

// 429 interceptor: normalise into the standard { detail: "..." } shape.
// 401 interceptor: redirect to auth login.
client.interceptors.response.use(undefined, (error: AxiosError) => {
  if (error.response?.status === 401) {
    redirect.fn(authLoginUrl(window.location.href))
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
    const response = await client.get<MeResponse>('/me')
    return response.data
  },

  // ── Subscriptions ─────────────────────────────────────────────────────────

  async getSubscriptions(noCache = false): Promise<SubscriptionList> {
    const headers: Record<string, string> = {}
    if (noCache) headers['Cache-Control'] = 'no-cache'
    const response = await client.get<SubscriptionList>('/subscriptions', { headers })
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
  async refreshSubscription(sid: string): Promise<void> {
    await client.post(`/subscriptions/${sid}/syncs`, null)
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
    session_id?: string
    department_id?: string
    grade?: string
  }): Promise<{ results: SearchResult[] }> {
    const query = new URLSearchParams({ source_type: params.source_type, keyword: params.keyword })
    if (params.session_id) query.append('session_id', params.session_id)
    if (params.department_id) query.append('department_id', params.department_id)
    if (params.grade) query.append('grade', params.grade)
    const response = await client.get<{ results: SearchResult[] }>(`/external/search?${query}`)
    return response.data
  },

  async getDepartments(): Promise<{ departments: DepartmentNode[] }> {
    const response = await client.get<{ departments: DepartmentNode[] }>('/external/departments')
    return response.data
  },

  // ── Public calendar view (no auth; uses the public /api/v2/calendar/ path) ─

  /** GET /api/v2/calendar/:token/view.json — used by the /view page (FE-4). */
  async getViewData(token: string): Promise<CalendarData> {
    const response = await client.get<CalendarData>(
      `/calendar/${encodeURIComponent(token)}/view.json`,
    )
    return response.data
  },

  // ── Health & config ───────────────────────────────────────────────────────

  async getHealth(): Promise<HealthStatus> {
    const response = await client.get<HealthStatus>('/health')
    return response.data
  },

  async getConfig(): Promise<AppConfig> {
    const response = await client.get<AppConfig>('/config')
    return response.data
  },
}
