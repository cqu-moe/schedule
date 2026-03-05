import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mockUserInfo } from '@/test-utils'

const mockApi = vi.hoisted(() => ({
  register: vi.fn(),
  recoverToken: vi.fn(),
  recoverTokenVerify: vi.fn(),
  getCaptchaConfig: vi.fn(),
  getUserInfo: vi.fn(),
  deleteUser: vi.fn(),
  searchSchedule: vi.fn(),
  getDepartments: vi.fn(),
  createSubscription: vi.fn(),
  getSubscriptions: vi.fn(),
  deleteSubscription: vi.fn(),
  refreshSubscription: vi.fn(),
  getHealth: vi.fn(),
  getConfig: vi.fn(),
}))

vi.mock('@/api', () => ({ default: mockApi }))

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    // Reset all mocks before each test
    Object.values(mockApi).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        ;(fn as ReturnType<typeof vi.fn>).mockReset()
      }
    })
  })

  describe('initial state', () => {
    it('has empty token when localStorage is empty', async () => {
      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      expect(store.token).toBe('')
      expect(store.isAuthenticated).toBe(false)
    })

    it('reads token from localStorage', async () => {
      localStorage.setItem('calendar_token', 'stored-token')
      // getUserInfo must be mocked so the auto-fetchUserInfo call does not fail unhandled
      mockApi.getUserInfo.mockResolvedValue(mockUserInfo())

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      expect(store.token).toBe('stored-token')
      expect(store.isAuthenticated).toBe(true)
    })

    it('calls fetchUserInfo when token exists in localStorage', async () => {
      localStorage.setItem('calendar_token', 'existing-token')
      mockApi.getUserInfo.mockResolvedValue(mockUserInfo())

      const { useAuthStore } = await import('@/stores/auth')
      useAuthStore()

      // The store auto-calls fetchUserInfo on creation when token exists
      expect(mockApi.getUserInfo).toHaveBeenCalledWith('existing-token')
    })
  })

  describe('register', () => {
    it('sets token and localStorage on success', async () => {
      mockApi.register.mockResolvedValue({ calendar_token: 'new-token-123' })

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      const result = await store.register('20210001', 'password123')

      expect(result).toEqual({ success: true, token: 'new-token-123' })
      expect(store.token).toBe('new-token-123')
      expect(localStorage.getItem('calendar_token')).toBe('new-token-123')
    })

    it('passes captcha token to API', async () => {
      mockApi.register.mockResolvedValue({ calendar_token: 'token-with-captcha' })

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      await store.register('20210001', 'password123', 'captcha-token-abc')

      expect(mockApi.register).toHaveBeenCalledWith('20210001', 'password123', 'captcha-token-abc')
    })

    it('returns rate limit message on 429 error', async () => {
      mockApi.register.mockRejectedValue({
        response: { status: 429, data: { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } } },
      })

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      const result = await store.register('20210001', 'password123')

      expect(result).toEqual({ success: false, error: '操作过于频繁，请稍后再试' })
    })

    it('returns captcha error on CAPTCHA_REQUIRED', async () => {
      mockApi.register.mockRejectedValue({
        response: { status: 400, data: { detail: { error: { code: 'CAPTCHA_REQUIRED', message: 'CAPTCHA_REQUIRED' } } } },
      })

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      const result = await store.register('20210001', 'password123')

      expect(result).toEqual({ success: false, error: '验证码验证失败，请刷新页面重试' })
    })

    it('sets loading during request', async () => {
      let resolveRegister: (value: any) => void
      mockApi.register.mockReturnValue(
        new Promise((resolve) => {
          resolveRegister = resolve
        }),
      )

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()

      expect(store.loading).toBe(false)
      const promise = store.register('20210001', 'password123')
      expect(store.loading).toBe(true)

      resolveRegister!({ calendar_token: 'token' })
      await promise

      expect(store.loading).toBe(false)
    })
  })

  describe('loginWithToken', () => {
    it('sets token, userInfo, and localStorage on success', async () => {
      const info = mockUserInfo()
      mockApi.getUserInfo.mockResolvedValue(info)

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      const result = await store.loginWithToken('my-calendar-token')

      expect(result).toEqual({ success: true })
      expect(store.token).toBe('my-calendar-token')
      expect(store.userInfo).toEqual(info)
      expect(localStorage.getItem('calendar_token')).toBe('my-calendar-token')
    })

    it('returns error on failure', async () => {
      mockApi.getUserInfo.mockRejectedValue(new Error('Network error'))

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      const result = await store.loginWithToken('bad-token')

      expect(result).toEqual({ success: false, error: 'Token 无效或已过期' })
    })
  })

  describe('fetchUserInfo', () => {
    it('sets userInfo on success', async () => {
      const info = mockUserInfo()
      mockApi.getUserInfo.mockResolvedValue(info)

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()

      // Manually set token first (without triggering auto-fetch which already happened)
      store.token = 'test-token'
      mockApi.getUserInfo.mockResolvedValue(info)
      await store.fetchUserInfo()

      expect(store.userInfo).toEqual(info)
      expect(mockApi.getUserInfo).toHaveBeenCalledWith('test-token')
    })

    it('is a no-op when no token', async () => {
      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()

      // token is '' by default (no localStorage)
      await store.fetchUserInfo()

      expect(mockApi.getUserInfo).not.toHaveBeenCalled()
    })

    it('calls logout on error', async () => {
      mockApi.getUserInfo.mockRejectedValue(new Error('Unauthorized'))

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()
      store.token = 'expired-token'
      localStorage.setItem('calendar_token', 'expired-token')

      await store.fetchUserInfo()

      expect(store.token).toBe('')
      expect(store.userInfo).toBeNull()
      expect(localStorage.getItem('calendar_token')).toBeNull()
    })
  })

  describe('logout', () => {
    it('clears token, userInfo, and localStorage', async () => {
      mockApi.getUserInfo.mockResolvedValue(mockUserInfo())
      localStorage.setItem('calendar_token', 'some-token')

      const { useAuthStore } = await import('@/stores/auth')
      const store = useAuthStore()

      // Ensure there is some state
      store.token = 'some-token'
      store.userInfo = mockUserInfo() as any

      store.logout()

      expect(store.token).toBe('')
      expect(store.userInfo).toBeNull()
      expect(store.isAuthenticated).toBe(false)
      expect(localStorage.getItem('calendar_token')).toBeNull()
    })
  })
})
