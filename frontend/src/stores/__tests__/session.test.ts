import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mockMeResponse, mockCalendarCaps } from '@/test-utils'

const mockApi = vi.hoisted(() => ({
  getMe: vi.fn(),
  getConfig: vi.fn(),
  // other v2 methods (not used by session store, but needed for mock completeness)
  getSubscriptions: vi.fn(),
  getSubscription: vi.fn(),
  createSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  refreshSubscription: vi.fn(),
  getLinks: vi.fn(),
  createLink: vi.fn(),
  patchLink: vi.fn(),
  deleteLink: vi.fn(),
  rotateLink: vi.fn(),
  searchExternal: vi.fn(),
  getDepartments: vi.fn(),
  getViewData: vi.fn(),
  getHealth: vi.fn(),
}))

vi.mock('@/api', () => ({ default: mockApi }))

describe('session store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(mockApi).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) {
        ;(fn as ReturnType<typeof vi.fn>).mockReset()
      }
    })
  })

  // ── Initial state ──

  describe('initial state', () => {
    it('starts unauthenticated', async () => {
      const { useSession } = await import('@/stores/session')
      const store = useSession()

      expect(store.user).toBeNull()
      expect(store.caps).toBeNull()
      expect(store.loaded).toBe(false)
      expect(store.loading).toBe(false)
      expect(store.isAuthenticated).toBe(false)
    })
  })

  // ── load() ──

  describe('load()', () => {
    it('populates user and caps on success', async () => {
      const me = { ...mockMeResponse(), cquBindStatus: 'active' as const }
      mockApi.getMe.mockResolvedValue(me)

      const { useSession } = await import('@/stores/session')
      const store = useSession()

      await store.load()

      expect(store.user).toEqual(me.user)
      expect(store.caps).toEqual(me.caps.calendar)
      expect(store.loaded).toBe(true)
      expect(store.isAuthenticated).toBe(true)
      expect(store.cquBindStatus).toBe('active')
      expect(store.isCquBound).toBe(true)
    })

    it('rejects and leaves store unloaded on API error', async () => {
      mockApi.getMe.mockRejectedValue(new Error('Network error'))

      const { useSession } = await import('@/stores/session')
      const store = useSession()

      await expect(store.load()).rejects.toThrow('Network error')

      expect(store.user).toBeNull()
      expect(store.loaded).toBe(false)
    })

    it('sets loading=true during request then false after', async () => {
      let resolve: (v: any) => void
      mockApi.getMe.mockReturnValue(new Promise((r) => { resolve = r }))

      const { useSession } = await import('@/stores/session')
      const store = useSession()

      const promise = store.load()
      expect(store.loading).toBe(true)

      resolve!(mockMeResponse())
      await promise

      expect(store.loading).toBe(false)
    })

    it('deduplicates concurrent in-flight load() calls', async () => {
      let resolve: (v: any) => void
      mockApi.getMe.mockReturnValue(new Promise((r) => { resolve = r }))

      const { useSession } = await import('@/stores/session')
      const store = useSession()

      // Start two concurrent calls — the second should return early (loading=true)
      const p1 = store.load()
      const p2 = store.load() // should be a no-op: loading is already true

      // Resolve the pending request
      resolve!(mockMeResponse())
      await Promise.allSettled([p1, p2])

      // getMe should only have been called once
      expect(mockApi.getMe).toHaveBeenCalledTimes(1)
    })
  })

  // ── can() ──

  describe('can()', () => {
    it('returns true when the flag is enabled', async () => {
      mockApi.getMe.mockResolvedValue(mockMeResponse({ caps: mockCalendarCaps({ sync: true, external: true, share: true, change_notification: true }) }))

      const { useSession } = await import('@/stores/session')
      const store = useSession()
      await store.load()

      expect(store.can('sync')).toBe(true)
      expect(store.can('external')).toBe(true)
      expect(store.can('share')).toBe(true)
      expect(store.can('change_notification')).toBe(true)
    })

    it('returns false when the flag is disabled', async () => {
      mockApi.getMe.mockResolvedValue(
        mockMeResponse({ caps: mockCalendarCaps({ sync: false, external: false, share: false }) }),
      )

      const { useSession } = await import('@/stores/session')
      const store = useSession()
      await store.load()

      expect(store.can('sync')).toBe(false)
      expect(store.can('external')).toBe(false)
      expect(store.can('share')).toBe(false)
    })

    it('returns false when caps is null (not loaded)', async () => {
      const { useSession } = await import('@/stores/session')
      const store = useSession()
      // caps is null — not loaded
      expect(store.can('sync')).toBe(false)
    })
  })

  // ── quota() ──

  describe('quota()', () => {
    it('returns the quota value from caps', async () => {
      mockApi.getMe.mockResolvedValue(
        mockMeResponse({
          caps: mockCalendarCaps({ sub_limit: 5, share_limit: 10, sync_interval: 60, manual_refresh: 3 }),
        }),
      )

      const { useSession } = await import('@/stores/session')
      const store = useSession()
      await store.load()

      expect(store.quota('sub_limit')).toBe(5)
      expect(store.quota('share_limit')).toBe(10)
      expect(store.quota('sync_interval')).toBe(60)
      expect(store.quota('manual_refresh')).toBe(3)
    })

    it('returns null for null quota values (unlimited)', async () => {
      mockApi.getMe.mockResolvedValue(
        mockMeResponse({ caps: mockCalendarCaps({ sub_limit: null, share_limit: null }) }),
      )

      const { useSession } = await import('@/stores/session')
      const store = useSession()
      await store.load()

      expect(store.quota('sub_limit')).toBeNull()
      expect(store.quota('share_limit')).toBeNull()
    })

    it('returns null when caps not loaded', async () => {
      const { useSession } = await import('@/stores/session')
      const store = useSession()

      expect(store.quota('sub_limit')).toBeNull()
    })
  })

  // ── $reset() ──

  describe('$reset()', () => {
    it('clears user, caps, and loaded', async () => {
      mockApi.getMe.mockResolvedValue(mockMeResponse())

      const { useSession } = await import('@/stores/session')
      const store = useSession()
      await store.load()

      expect(store.user).not.toBeNull()
      expect(store.loaded).toBe(true)

      store.$reset()

      expect(store.user).toBeNull()
      expect(store.caps).toBeNull()
      expect(store.cquBindStatus).toBeUndefined()
      expect(store.loaded).toBe(false)
      expect(store.loading).toBe(false)
      expect(store.isAuthenticated).toBe(false)
    })
  })
})
