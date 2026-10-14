import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Use vi.hoisted so the mock client is available when vi.mock factory runs (hoisted above imports)
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      response: { use: vi.fn() },
    },
  }
  return { mockClient }
})

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockClient),
  },
}))

// Import after mock is set up — this triggers axios.create() and interceptors.response.use()
import axios from 'axios'
import api, { redirect } from '../index'
import { signedOutUrl } from '@/config/auth'

// Capture setup-time calls before any test's beforeEach can clear them
const createCallArgs = (axios.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
const interceptorErrorHandler = mockClient.interceptors.response.use.mock.calls[0]?.[1] as
  | ((error: unknown) => Promise<never>)
  | undefined

describe('API module (v2)', () => {
  beforeEach(() => {
    mockClient.get.mockReset()
    mockClient.post.mockReset()
    mockClient.put.mockReset()
    mockClient.patch.mockReset()
    mockClient.delete.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts an owner receipt to the existing target-selection endpoint and reads a reused queued run', async () => {
    mockClient.post.mockResolvedValue({ status: 202, data: { status: 'queued', run_id: 'run-11', reused: true } })
    const body = { sourceType: 'course', sourceId: 'class-new', sourceName: '物理01班', selectionToken: 'owner-receipt', sessionId: 'current' }
    expect(await api.reselectTeachingClass('original', body)).toEqual({ status: 'queued', run_id: 'run-11', reused: true })
    expect(mockClient.post).toHaveBeenCalledExactlyOnceWith('/subscriptions/original/target-selection', body)
  })

  // ── Client config ──

  describe('client configuration', () => {
    it('creates axios client with /api/v2 baseURL', () => {
      expect(createCallArgs).toMatchObject({
        baseURL: '/api/v2',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    })
  })

  // ── Response interceptor ──

  describe('response interceptor', () => {
    it('redirects to auth.cqu.moe on 401 with exact redirect URL', async () => {
      // `redirect.fn` is a mutable property on the exported `redirect` object —
      // the interceptor reads it at call time, so replacing it here is effective.
      const redirectSpy = vi.fn()
      const originalFn = redirect.fn
      redirect.fn = redirectSpy

      const error = { response: { status: 401, data: {} }, config: {} }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)

      // Assert the exact URL passed to redirect.fn by the interceptor.
      // jsdom's window.location.href defaults to 'http://localhost:3000/'.
      const expectedUrl = signedOutUrl(window.location.href)
      expect(redirectSpy).toHaveBeenCalledOnce()
      expect(redirectSpy).toHaveBeenCalledWith(expectedUrl)

      redirect.fn = originalFn
    })

    it('does NOT redirect on 401 when suppressAuthRedirect is true', async () => {
      const redirectSpy = vi.fn()
      const originalFn = redirect.fn
      redirect.fn = redirectSpy

      const error = { response: { status: 401, data: {} }, config: { suppressAuthRedirect: true } }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)

      expect(redirectSpy).not.toHaveBeenCalled()

      redirect.fn = originalFn
    })

    it('does NOT redirect on 401 when error code is TOKEN_EXPIRED (upstream CQU token)', async () => {
      const redirectSpy = vi.fn()
      const originalFn = redirect.fn
      redirect.fn = redirectSpy

      const error = {
        response: {
          status: 401,
          data: { detail: { error: { code: 'TOKEN_EXPIRED' } } },
        },
        config: {},
      }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)

      // Schedule session is still valid — must NOT redirect to login
      expect(redirectSpy).not.toHaveBeenCalled()

      redirect.fn = originalFn
    })

    it('redirects on 401 when error code is UNAUTHORIZED (schedule session invalid)', async () => {
      const redirectSpy = vi.fn()
      const originalFn = redirect.fn
      redirect.fn = redirectSpy

      const error = {
        response: {
          status: 401,
          data: { detail: { error: { code: 'UNAUTHORIZED' } } },
        },
        config: {},
      }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)

      expect(redirectSpy).toHaveBeenCalledOnce()

      redirect.fn = originalFn
    })

    it('redirects on 401 when response body has no error code (fallback to session-expired behaviour)', async () => {
      const redirectSpy = vi.fn()
      const originalFn = redirect.fn
      redirect.fn = redirectSpy

      const error = {
        response: { status: 401, data: { detail: 'Unauthorized' } },
        config: {},
      }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)

      expect(redirectSpy).toHaveBeenCalledOnce()

      redirect.fn = originalFn
    })

    it('injects rate-limit detail on 429 with no body', async () => {
      const error = { response: { status: 429, data: {} } }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
      expect((error.response.data as Record<string, unknown>).detail).toBe(
        '操作过于频繁，请稍后再试',
      )
    })

    it('preserves existing body on 429', async () => {
      const error = {
        response: { status: 429, data: { detail: '已有 detail' } },
      }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
      expect(error.response.data.detail).toBe('已有 detail')
    })

    it('passes through non-429/401 errors unchanged', async () => {
      const error = { response: { status: 500, data: { detail: 'server error' } } }
      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
      expect(error.response.data.detail).toBe('server error')
    })
  })

  // ── getMe ──

  describe('getMe', () => {
    it('GET /me returns me response', async () => {
      const me = { user: { id: 'u1', name: 'A', email: 'a@b.com', role: 'student' }, caps: { calendar: { sync: true } } }
      mockClient.get.mockResolvedValueOnce({ data: me })

      const result = await api.getMe()

      expect(mockClient.get).toHaveBeenCalledWith('/me', { suppressAuthRedirect: true })
      expect(result).toEqual(me)
    })
  })

  describe('notification settings', () => {
    it('loads and updates the current user preference', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { eligible: true, enabled: false } })
      mockClient.put.mockResolvedValueOnce({ data: { eligible: true, enabled: true } })

      await expect(api.getNotificationSettings()).resolves.toEqual({ eligible: true, enabled: false })
      await expect(api.updateNotificationSettings(true)).resolves.toEqual({ eligible: true, enabled: true })

      expect(mockClient.get).toHaveBeenCalledWith('/notification-settings')
      expect(mockClient.put).toHaveBeenCalledWith('/notification-settings', { enabled: true })
    })
  })

  // ── getSubscriptions ──

  describe('getSubscriptions', () => {
    it('GET /subscriptions without extra headers by default', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { subscriptions: [], count: 0 } })

      const result = await api.getSubscriptions()

      expect(mockClient.get).toHaveBeenCalledWith('/subscriptions', { headers: {} })
      expect(result).toEqual({ subscriptions: [], count: 0 })
    })

    it('adds Cache-Control: no-cache when noCache=true', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { subscriptions: [], count: 0 } })

      await api.getSubscriptions(true)

      expect(mockClient.get).toHaveBeenCalledWith('/subscriptions', {
        headers: { 'Cache-Control': 'no-cache' },
      })
    })
  })

  describe('ensureDefaultSubscriptions', () => {
    it('POSTs to /subscriptions/defaults without identity or subscription data', async () => {
      const setup = {
        status: 'created',
        subscription_ids: ['a', 'b', 'c'],
        run_id: 'run-1',
        dispatch_status: 'sent',
      }
      mockClient.post.mockResolvedValueOnce({ data: setup })

      await expect(api.ensureDefaultSubscriptions()).resolves.toEqual(setup)
      expect(mockClient.post).toHaveBeenCalledWith('/subscriptions/defaults')
    })
  })

  // ── deleteSubscription ──

  describe('deleteSubscription', () => {
    it('DELETE /subscriptions/:sid', async () => {
      mockClient.delete.mockResolvedValueOnce({})

      await api.deleteSubscription('sub-abc')

      expect(mockClient.delete).toHaveBeenCalledWith('/subscriptions/sub-abc')
    })
  })

  // ── refreshSubscription ──

  describe('refreshSubscription', () => {
    it('POST /subscriptions/:sid/syncs', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { status: 'queued', run_id: 'run-1' } })

      const result = await api.refreshSubscription('sub-abc')

      expect(mockClient.post).toHaveBeenCalledWith('/subscriptions/sub-abc/syncs', null)
      expect(result).toEqual({ status: 'queued', run_id: 'run-1' })
    })
  })

  describe('refreshPersonalSubscription', () => {
    it('POST /subscriptions/personal/syncs without a client identity', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { status: 'queued', run_id: 'personal-run' } })

      const result = await api.refreshPersonalSubscription()

      expect(mockClient.post).toHaveBeenCalledWith('/subscriptions/personal/syncs', null)
      expect(result).toEqual({ status: 'queued', run_id: 'personal-run' })
    })
  })

  // ── createSubscription ──

  describe('createSubscription', () => {
    it('POST /subscriptions with body and 120s timeout', async () => {
      const sub = { id: 'new-sub', source_type: 'personal_all' }
      mockClient.post.mockResolvedValueOnce({ data: sub })

      const result = await api.createSubscription({
        sourceType: 'personal_all',
        sourceName: '张三',
      })

      expect(mockClient.post).toHaveBeenCalledWith(
        '/subscriptions',
        { sourceType: 'personal_all', sourceName: '张三' },
        { timeout: 120000 },
      )
      expect(result).toEqual(sub)
    })
  })

  // ── getLinks ──

  describe('getLinks', () => {
    it('GET /subscriptions/:sid/links', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { links: [], count: 0 } })

      const result = await api.getLinks('sub-abc')

      expect(mockClient.get).toHaveBeenCalledWith('/subscriptions/sub-abc/links')
      expect(result).toEqual({ links: [], count: 0 })
    })
  })

  // ── rotateLink ──

  describe('rotateLink', () => {
    it('POST /subscriptions/:sid/links/:lid/rotations', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { token: 'new-token', url: 'https://...' } })

      const result = await api.rotateLink('sub-abc', 'link-xyz')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/subscriptions/sub-abc/links/link-xyz/rotations',
        null,
      )
      expect(result).toEqual({ token: 'new-token', url: 'https://...' })
    })
  })

  // ── searchExternal ──

  describe('searchExternal', () => {
    it('GET /external/search with source_type and keyword', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { results: [] } })

      const result = await api.searchExternal({ source_type: 'instructor', keyword: '张三' })

      expect(mockClient.get).toHaveBeenCalledWith(
        '/external/search?source_type=instructor&keyword=%E5%BC%A0%E4%B8%89',
        { timeout: 100_000, signal: undefined },
      )
      expect(result).toEqual({ results: [] })
    })

    it('includes optional params when provided', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { results: [] } })

      await api.searchExternal({
        source_type: 'admin_class',
        keyword: 'test',
        department_id: 'dept1',
        grade: '2021',
      })

      const call = mockClient.get.mock.calls[0][0] as string
      expect(call).toContain('department_id=dept1')
      expect(call).toContain('grade=2021')
    })

    it('recovers a network loss through bounded EXTERNAL_BUSY retries without retrying terminal errors', async () => {
      const networkError = Object.assign(new Error('Network Error'), {
        code: 'ERR_NETWORK',
        isAxiosError: true,
      })
      const busyError = {
        response: {
          status: 503,
          data: { detail: { error: { code: 'EXTERNAL_BUSY', message: 'busy' } } },
        },
      }
      const unauthorized = {
        response: {
          status: 401,
          data: { detail: { error: { code: 'UNAUTHORIZED', message: 'unauthorized' } } },
        },
      }
      const result = { results: [{ id: 'teacher', name: '张三', extra: '' }] }
      mockClient.get.mockImplementation(async () => {
        const attempt = mockClient.get.mock.calls.length
        if (attempt === 1) {
          await new Promise(resolve => setTimeout(resolve, 0))
          throw networkError
        }
        if (attempt === 2) throw busyError
        return { data: result }
      })

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const promise = api.searchExternal({ source_type: 'instructor', keyword: '张三' })
      const resolution = expect(promise).resolves.toEqual(result)
      await Promise.resolve()
      await vi.runAllTimersAsync()
      await resolution

      expect(mockClient.get).toHaveBeenCalledTimes(3)

      mockClient.get.mockReset().mockRejectedValueOnce(networkError).mockRejectedValueOnce(unauthorized)
      const terminalPromise = api.searchExternal({ source_type: 'instructor', keyword: '李四' })
      const terminalRejection = expect(terminalPromise).rejects.toBe(unauthorized)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(7_500)
      await terminalRejection
      expect(mockClient.get).toHaveBeenCalledTimes(2)
    })

    it('retries EXTERNAL_BUSY on the first response and returns the cached success', async () => {
      const busyError = {
        response: {
          status: 503,
          data: { detail: { error: { code: 'EXTERNAL_BUSY', message: 'busy' } } },
        },
      }
      const result = { results: [] }
      mockClient.get
        .mockRejectedValueOnce(busyError)
        .mockResolvedValueOnce({ data: result })

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const promise = api.searchExternal({ source_type: 'instructor', keyword: '张三' })
      const resolution = expect(promise).resolves.toEqual(result)
      await vi.runAllTimersAsync()
      await resolution

      expect(mockClient.get).toHaveBeenCalledTimes(2)
    })

    it('stops retrying at the bounded attempt count within the external lookup budget', async () => {
      const networkError = Object.assign(new Error('Network Error'), {
        code: 'ERR_NETWORK',
        isAxiosError: true,
      })
      const busyError = {
        response: {
          status: 503,
          data: { detail: { error: { code: 'EXTERNAL_BUSY', message: 'busy' } } },
        },
      }
      mockClient.get.mockImplementation(async () => {
        const attempt = mockClient.get.mock.calls.length
        if (attempt === 1) {
          await new Promise(resolve => setTimeout(resolve, 30_000))
          throw networkError
        }
        throw busyError
      })

      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
      const startedAt = Date.now()
      const promise = api.searchExternal({ source_type: 'instructor', keyword: '张三' })
      const rejection = expect(promise).rejects.toBe(busyError)
      await vi.runAllTimersAsync()

      await rejection
      expect(mockClient.get).toHaveBeenCalledTimes(10)
      expect(Date.now() - startedAt).toBeLessThanOrEqual(100_000)
    })

    it('propagates AbortSignal and does not recover a cancelled request', async () => {
      const controller = new AbortController()
      const cancelledError = Object.assign(new Error('canceled'), {
        code: 'ERR_CANCELED',
        name: 'CanceledError',
      })
      mockClient.get.mockImplementationOnce(async (_url, config) => {
        expect(config?.signal).toBe(controller.signal)
        controller.abort()
        throw cancelledError
      })

      await expect(
        api.searchExternal({ source_type: 'instructor', keyword: '张三' }, { signal: controller.signal }),
      ).rejects.toBe(cancelledError)
      expect(mockClient.get).toHaveBeenCalledTimes(1)
    })
  })

  describe('searchTeachingClasses', () => {
    it('GET /external/teaching-classes with the lookup timeout and AbortSignal', async () => {
      const controller = new AbortController()
      const result = { results: [] }
      mockClient.get.mockResolvedValueOnce({ data: result })

      await expect(
        api.searchTeachingClasses('course-1', 'token-1', { signal: controller.signal }),
      ).resolves.toEqual(result)
      expect(mockClient.get).toHaveBeenCalledWith(
        '/external/teaching-classes?course_id=course-1&selection_token=token-1',
        { timeout: 100_000, signal: controller.signal },
      )
    })
  })

  // ── getDepartments ──

  describe('getDepartments', () => {
    it('GET /external/departments', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { departments: [] } })

      const result = await api.getDepartments()

      expect(mockClient.get).toHaveBeenCalledWith('/external/departments', { timeout: 100_000, signal: undefined })
      expect(result).toEqual({ departments: [] })
    })
  })

  // ── getViewData ──

  describe('getViewData', () => {
    it('GET /calendar/:token/view.json', async () => {
      const data = { semester: '2025秋', semester_start: '2025-09-01', generated_at: 'now', events: [] }
      mockClient.get.mockResolvedValueOnce({ data })

      const result = await api.getViewData('abc123')

      expect(mockClient.get).toHaveBeenCalledWith('/calendar/abc123/view.json', {
        suppressAuthRedirect: true,
      })
      expect(result).toEqual(data)
    })
  })

  // ── getConfig ──

  describe('getConfig', () => {
    it('GET /config', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { public_url: 'https://schedule.cqu.moe' } })

      const result = await api.getConfig()

      expect(mockClient.get).toHaveBeenCalledWith('/config')
      expect(result).toEqual({ public_url: 'https://schedule.cqu.moe' })
    })
  })
})
