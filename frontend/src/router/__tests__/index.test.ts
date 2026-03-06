import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// Mock the API module before any store/router imports
vi.mock('@/api', () => ({
  default: {
    register: vi.fn(),
    getUserInfo: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn(),
    getConfig: vi.fn(),
  },
}))

import router from '@/router'
import { useAuthStore } from '@/stores/auth'

describe('Router', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    // Reset router to home before each test
    router.push('/')
    await router.isReady()
  })

  describe('public routes accessible without auth', () => {
    it.each([
      ['/', 'Home'],
      ['/login', 'Login'],
      ['/register', 'Register'],
      ['/recover', 'Recover'],
      ['/api-docs', 'ApiDocs'],
    ])('%s resolves to %s without auth', async (path, expectedName) => {
      await router.push(path)
      expect(router.currentRoute.value.name).toBe(expectedName)
    })
  })

  describe('protected routes redirect when not authenticated', () => {
    it('/dashboard redirects to /login with redirect query', async () => {
      await router.push('/dashboard')
      expect(router.currentRoute.value.name).toBe('Login')
      expect(router.currentRoute.value.query).toEqual({ redirect: '/dashboard' })
    })

    it('/add redirects to /login with redirect query', async () => {
      await router.push('/add')
      expect(router.currentRoute.value.name).toBe('Login')
      expect(router.currentRoute.value.query).toEqual({ redirect: '/add' })
    })
  })

  describe('protected routes accessible when authenticated', () => {
    beforeEach(() => {
      const authStore = useAuthStore()
      authStore.token = 'test-token'
    })

    it('/dashboard is accessible when authenticated', async () => {
      await router.push('/dashboard')
      expect(router.currentRoute.value.name).toBe('Dashboard')
    })

    it('/add is accessible when authenticated', async () => {
      await router.push('/add')
      expect(router.currentRoute.value.name).toBe('Add')
    })
  })
})
