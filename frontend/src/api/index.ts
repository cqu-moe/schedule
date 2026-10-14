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

const EXTERNAL_LOOKUP_TIMEOUT_MS = 100_000
const EXTERNAL_RETRY_BACKOFF_MS = 7_500
const EXTERNAL_MAX_ATTEMPTS = 10

type ExternalLookupOptions = { signal?: AbortSignal }

function externalBusy(error: AxiosError): boolean {
  const detail = error.response?.data as Record<string, unknown> | undefined
  return error.response?.status === 503 &&
    (detail?.detail as Record<string, unknown> | undefined)?.error !== undefined &&
    ((detail?.detail as Record<string, unknown>).error as Record<string, unknown>)?.code === 'EXTERNAL_BUSY'
}

function externalNetworkLoss(error: AxiosError): boolean {
  return error.code === 'ERR_NETWORK' && error.response === undefined
}

function requestCancelled(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string }
  return candidate?.code === 'ERR_CANCELED' || candidate?.name === 'CanceledError'
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

function waitForExternalRetry(signal: AbortSignal, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, duration)

    function onAbort() {
      clearTimeout(timer)
      reject(abortError(signal))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function externalGet<T>(url: string, { signal }: ExternalLookupOptions = {}): Promise<T> {
  const startedAt = Date.now()

  for (let attempt = 1; attempt <= EXTERNAL_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError(signal)
    const remaining = attempt === 1 ? EXTERNAL_LOOKUP_TIMEOUT_MS : startedAt + EXTERNAL_LOOKUP_TIMEOUT_MS - Date.now()
    if (remaining <= 0) throw new DOMException('External lookup timed out', 'TimeoutError')

    try {
      const response = await client.get<T>(url, { timeout: remaining, signal })
      return response.data
    } catch (error) {
      if (requestCancelled(error)) throw error

      const axiosError = error as AxiosError
      if (!externalNetworkLoss(axiosError) && !externalBusy(axiosError)) {
        throw error
      }

      if (attempt === EXTERNAL_MAX_ATTEMPTS) throw error
      if (Date.now() + EXTERNAL_RETRY_BACKOFF_MS > startedAt + EXTERNAL_LOOKUP_TIMEOUT_MS) throw error
      if (signal) await waitForExternalRetry(signal, EXTERNAL_RETRY_BACKOFF_MS)
      else await new Promise(resolve => setTimeout(resolve, EXTERNAL_RETRY_BACKOFF_MS))
    }
  }

  throw new Error('External lookup recovery ended unexpectedly')
}

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
    selectionToken?: string
    sourceName: string
    sessionId?: string
    sessionName?: string
    semesterStart?: string
    isPersonal?: boolean
  }): Promise<Subscription> {
    const response = await client.post<Subscription>('/subscriptions', body, { timeout: 120000 })
    return response.data
  },

  async reselectTeachingClass(sid: string, body: {
    sourceType: string
    sourceId: string
    sourceName: string
    selectionToken: string
    sessionId: string
  }): Promise<{ status: 'queued'; run_id: string; reused: boolean }> {
    const response = await client.post<{ status: 'queued'; run_id: string; reused: boolean }>(
      `/subscriptions/${encodeURIComponent(sid)}/target-selection`, body,
    )
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
  }, options?: ExternalLookupOptions): Promise<ExternalSearchResponse> {
    const query = new URLSearchParams({ source_type: params.source_type, keyword: params.keyword })
    if (params.department_id) query.append('department_id', params.department_id)
    if (params.grade) query.append('grade', params.grade)
    return externalGet<ExternalSearchResponse>(`/external/search?${query}`, options)
  },

  async searchTeachingClasses(
    courseId: string,
    selectionToken: string,
    options?: ExternalLookupOptions,
  ): Promise<ExternalSearchResponse> {
    const query = new URLSearchParams({ course_id: courseId, selection_token: selectionToken })
    return externalGet<ExternalSearchResponse>(`/external/teaching-classes?${query}`, options)
  },

  async getDepartments(options?: ExternalLookupOptions): Promise<{
    session: ExternalSession
    departments: DepartmentNode[]
  }> {
    return externalGet<{ session: ExternalSession; departments: DepartmentNode[] }>(
      '/external/departments',
      options,
    )
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
