import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vi.hoisted so the mock client is available when vi.mock factory runs (hoisted above imports)
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    get: vi.fn(),
    post: vi.fn(),
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
import api from '../index.js'

// Capture setup-time calls before any test's beforeEach can clear them
const createCallArgs = (axios.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
const interceptorErrorHandler = mockClient.interceptors.response.use.mock.calls[0]?.[1] as
  | ((error: unknown) => Promise<never>)
  | undefined

describe('API module', () => {
  beforeEach(() => {
    // Only clear the HTTP method mocks, not the setup-time mocks (create, interceptors.response.use)
    mockClient.get.mockReset()
    mockClient.post.mockReset()
    mockClient.delete.mockReset()
  })

  // ── Client config ──

  describe('client configuration', () => {
    it('creates axios client with correct params', () => {
      expect(createCallArgs).toEqual({
        baseURL: '/api/v1',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    })
  })

  // ── Response interceptor ──

  describe('response interceptor', () => {
    it('provides fallback data on 429 error with no body', async () => {
      expect(interceptorErrorHandler).toBeDefined()

      const error = {
        response: { status: 429, data: {} },
      }

      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
      expect(error.response.data).toEqual({
        detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
      })
    })

    it('preserves existing body on 429 error', async () => {
      const error = {
        response: {
          status: 429,
          data: { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } },
        },
      }

      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
      expect(error.response.data).toEqual({
        detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
      })
    })

    it('passes through non-429 errors unchanged', async () => {
      const error = {
        response: { status: 500, data: { detail: { error: { code: 'INTERNAL_ERROR', message: 'Server error' } } } },
      }

      await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
      expect(error.response.data).toEqual({
        detail: { error: { code: 'INTERNAL_ERROR', message: 'Server error' } },
      })
    })
  })

  // ── register ──

  describe('register', () => {
    it('POST /users with body and 120s timeout', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { token: 'abc' } })

      const result = await api.register('2021001', 'pass123')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users',
        { student_id: '2021001', password: 'pass123' },
        { headers: {}, timeout: 120000 },
      )
      expect(result).toEqual({ token: 'abc' })
    })

    it('includes captcha header when provided', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { token: 'abc' } })

      await api.register('2021001', 'pass123', 'captcha-tok')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users',
        { student_id: '2021001', password: 'pass123' },
        { headers: { 'X-Captcha-Token': 'captcha-tok' }, timeout: 120000 },
      )
    })
  })

  // ── recoverToken ──

  describe('recoverToken', () => {
    it('POST /users/recover with body', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { message: 'ok' } })

      const result = await api.recoverToken('2021001', 'pass123')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users/recover',
        { student_id: '2021001', password: 'pass123' },
        { headers: {} },
      )
      expect(result).toEqual({ message: 'ok' })
    })
  })

  // ── recoverTokenVerify ──

  describe('recoverTokenVerify', () => {
    it('POST /users/recover/verify with 120s timeout', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { token: 'xyz' } })

      const result = await api.recoverTokenVerify('2021001', 'pass123')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users/recover/verify',
        { student_id: '2021001', password: 'pass123' },
        { headers: {}, timeout: 120000 },
      )
      expect(result).toEqual({ token: 'xyz' })
    })
  })

  // ── getCaptchaConfig ──

  describe('getCaptchaConfig', () => {
    it('GET /captcha/config', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { enabled: true, siteKey: 'key' } })

      const result = await api.getCaptchaConfig()

      expect(mockClient.get).toHaveBeenCalledWith('/captcha/config')
      expect(result).toEqual({ enabled: true, siteKey: 'key' })
    })
  })

  // ── getUserInfo ──

  describe('getUserInfo', () => {
    it('GET /users/me with auth header', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { student_id: '2021001' } })

      const result = await api.getUserInfo('my-token')

      expect(mockClient.get).toHaveBeenCalledWith('/users/me', { headers: { Authorization: 'Bearer my-token' } })
      expect(result).toEqual({ student_id: '2021001' })
    })
  })

  // ── deleteUser ──

  describe('deleteUser', () => {
    it('DELETE /users/me with auth header', async () => {
      mockClient.delete.mockResolvedValueOnce({})

      await api.deleteUser('my-token')

      expect(mockClient.delete).toHaveBeenCalledWith('/users/me', { headers: { Authorization: 'Bearer my-token' } })
    })
  })

  // ── searchSchedule ──

  describe('searchSchedule', () => {
    it('GET /search with query params and auth header', async () => {
      mockClient.get.mockResolvedValueOnce({ data: [{ name: 'Math' }] })

      const result = await api.searchSchedule('tok', 'course', 'math')

      expect(mockClient.get).toHaveBeenCalledWith(
        '/search?source_type=course&keyword=math',
        { headers: { Authorization: 'Bearer tok' } },
      )
      expect(result).toEqual([{ name: 'Math' }])
    })

    it('includes departmentId and grade when provided', async () => {
      mockClient.get.mockResolvedValueOnce({ data: [] })

      await api.searchSchedule('tok', 'course', 'math', 'dept1', '2021')

      expect(mockClient.get).toHaveBeenCalledWith(
        '/search?source_type=course&keyword=math&department_id=dept1&grade=2021',
        { headers: { Authorization: 'Bearer tok' } },
      )
    })
  })

  // ── getDepartments ──

  describe('getDepartments', () => {
    it('GET /departments with auth', async () => {
      mockClient.get.mockResolvedValueOnce({ data: [{ id: 'd1' }] })

      const result = await api.getDepartments('tok')

      expect(mockClient.get).toHaveBeenCalledWith('/departments', {
        headers: { Authorization: 'Bearer tok' },
      })
      expect(result).toEqual([{ id: 'd1' }])
    })
  })

  // ── createSubscription ──

  describe('createSubscription', () => {
    it('POST /subscriptions with body, auth, captcha, and 120s timeout', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { subscription_token: 'sub1' } })

      const result = await api.createSubscription('tok', 'course', 'c1', 'Math', 'cap-tok')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/subscriptions',
        { source_type: 'course', source_id: 'c1', source_name: 'Math' },
        {
          headers: { Authorization: 'Bearer tok', 'X-Captcha-Token': 'cap-tok' },
          timeout: 120000,
        },
      )
      expect(result).toEqual({ subscription_token: 'sub1' })
    })
  })

  // ── getSubscriptions ──

  describe('getSubscriptions', () => {
    it('GET /subscriptions with auth', async () => {
      mockClient.get.mockResolvedValueOnce({ data: [{ id: 1 }] })

      const result = await api.getSubscriptions('tok')

      expect(mockClient.get).toHaveBeenCalledWith('/subscriptions', {
        headers: { Authorization: 'Bearer tok' },
      })
      expect(result).toEqual([{ id: 1 }])
    })
  })

  // ── deleteSubscription ──

  describe('deleteSubscription', () => {
    it('DELETE /subscriptions/:subToken with auth', async () => {
      mockClient.delete.mockResolvedValueOnce({})

      await api.deleteSubscription('tok', 'sub1')

      expect(mockClient.delete).toHaveBeenCalledWith('/subscriptions/sub1', {
        headers: { Authorization: 'Bearer tok' },
      })
    })
  })

  // ── refreshSubscription ──

  describe('refreshSubscription', () => {
    it('POST /subscriptions/:subToken/refresh with auth and 120s timeout', async () => {
      mockClient.post.mockResolvedValueOnce({ data: { refreshed: true } })

      const result = await api.refreshSubscription('tok', 'sub1')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/subscriptions/sub1/refresh',
        null,
        { headers: { Authorization: 'Bearer tok' }, timeout: 120000 },
      )
      expect(result).toEqual({ refreshed: true })
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
      mockClient.get.mockResolvedValueOnce({ data: { version: '1.0' } })

      const result = await api.getConfig()

      expect(mockClient.get).toHaveBeenCalledWith('/config')
      expect(result).toEqual({ version: '1.0' })
    })
  })
})
