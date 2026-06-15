import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vi.hoisted so the mock client is available when vi.mock factory runs (hoisted above imports)
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    get: vi.fn(),
    post: vi.fn(),
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
import { authLoginUrl } from '@/config/auth'

// Capture setup-time calls before any test's beforeEach can clear them
const createCallArgs = (axios.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
const interceptorErrorHandler = mockClient.interceptors.response.use.mock.calls[0]?.[1] as
  | ((error: unknown) => Promise<never>)
  | undefined

describe('API module (v2)', () => {
  beforeEach(() => {
    mockClient.get.mockReset()
    mockClient.post.mockReset()
    mockClient.patch.mockReset()
    mockClient.delete.mockReset()
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
      const expectedUrl = authLoginUrl(window.location.href)
      // expectedUrl === 'https://auth.cqu.moe/login?redirect=http%3A%2F%2Flocalhost%3A3000%2F'
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

    it('still redirects on 401 for normal requests (suppressAuthRedirect absent)', async () => {
      const redirectSpy = vi.fn()
      const originalFn = redirect.fn
      redirect.fn = redirectSpy

      // Simulates getSubscriptions: no suppressAuthRedirect flag
      const error = { response: { status: 401, data: {} }, config: {} }
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
      mockClient.post.mockResolvedValueOnce({})

      await api.refreshSubscription('sub-abc')

      expect(mockClient.post).toHaveBeenCalledWith('/subscriptions/sub-abc/syncs', null)
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
  })

  // ── getDepartments ──

  describe('getDepartments', () => {
    it('GET /external/departments', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { departments: [] } })

      const result = await api.getDepartments()

      expect(mockClient.get).toHaveBeenCalledWith('/external/departments')
      expect(result).toEqual({ departments: [] })
    })
  })

  // ── getViewData ──

  describe('getViewData', () => {
    it('GET /calendar/:token/view.json', async () => {
      const data = { semester: '2025秋', semester_start: '2025-09-01', generated_at: 'now', events: [] }
      mockClient.get.mockResolvedValueOnce({ data })

      const result = await api.getViewData('abc123')

      expect(mockClient.get).toHaveBeenCalledWith('/calendar/abc123/view.json')
      expect(result).toEqual(data)
    })
  })

  // ── getHealth ──

  describe('getHealth', () => {
    it('GET /health', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { status: 'ok' } })

      const result = await api.getHealth()

      expect(mockClient.get).toHaveBeenCalledWith('/health')
      expect(result).toEqual({ status: 'ok' })
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
