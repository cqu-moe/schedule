import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// Mock the API module before any store/router imports
vi.mock('@/api', () => ({
  default: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
  },
}))

import router from '@/router'
import { RouteNames } from '@/router'

describe('Router (v2)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    router.push('/')
    await router.isReady()
  })

  // In v2, all routes are publicly accessible — auth redirects happen via the
  // 401 axios interceptor (cookie session). No router-level auth guard.
  describe('all routes are accessible without auth guard', () => {
    it.each([
      ['/', RouteNames.Home],
      ['/dashboard', RouteNames.Dashboard],
      ['/add', RouteNames.Add],
      ['/api-docs', RouteNames.ApiDocs],
      ['/changelog', RouteNames.Changelog],
    ])('%s resolves to %s', async (path, expectedName) => {
      await router.push(path)
      expect(router.currentRoute.value.name).toBe(expectedName)
    })
  })

  describe('removed routes (Login, Register, Recover) do not exist', () => {
    it.each(['/login', '/register', '/recover'])(
      '%s does not match a named route',
      async (path) => {
        await router.push(path)
        // Should not match any named route (no 404 redirect either; the SPA
        // simply leaves the route unmatched — currentRoute.name will be undefined)
        expect(router.currentRoute.value.name).toBeUndefined()
      },
    )
  })

  it('/view/:token route resolves with token param', async () => {
    await router.push('/view/my-link-token')
    expect(router.currentRoute.value.name).toBe(RouteNames.View)
    expect(router.currentRoute.value.params.token).toBe('my-link-token')
  })

  it('/calendar/:sub_token redirects to /view/:sub_token', async () => {
    await router.push('/calendar/my-link-token')
    expect(router.currentRoute.value.path).toBe('/view/my-link-token')
    expect(router.currentRoute.value.name).toBe(RouteNames.View)
  })
})
