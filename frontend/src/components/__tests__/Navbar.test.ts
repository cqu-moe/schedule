import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import Navbar from '@/components/Navbar.vue'

vi.mock('@/api', () => ({
  default: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn(),
  },
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'Home', component: { template: '<div>Home</div>' } },
      { path: '/dashboard', name: 'Dashboard', component: { template: '<div>Dashboard</div>' } },
      { path: '/add', name: 'Add', component: { template: '<div>Add</div>' } },
      { path: '/api-docs', name: 'ApiDocs', component: { template: '<div>Docs</div>' } },
    ],
  })
}

describe('Navbar', () => {
  let router: ReturnType<typeof createTestRouter>

  beforeEach(async () => {
    router = createTestRouter()
    router.push('/')
    await router.isReady()
  })

  function mountNavbar(authenticated = false) {
    const pinia = createTestingPinia({
      createSpy: vi.fn,
      stubActions: false,
      initialState: authenticated
        ? {
            session: {
              user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
              caps: { sync: true, external: true, share: true, sub_limit: 5, share_limit: null, sync_interval: 60, manual_refresh: 5 },
              loaded: true,
              loading: false,
            },
          }
        : {},
    })

    return mount(Navbar, {
      global: {
        plugins: [pinia, router],
      },
    })
  }

  describe('unauthenticated state', () => {
    it('shows a login link pointing to auth.cqu.moe when not authenticated', () => {
      const wrapper = mountNavbar(false)

      const loginLink = wrapper.find('a[href="https://auth.cqu.moe/login"]')
      expect(loginLink.exists()).toBe(true)
      expect(loginLink.text()).toContain('登录')
    })

    it('does not show dashboard, add subscription links when not authenticated', () => {
      const wrapper = mountNavbar(false)

      expect(wrapper.text()).not.toContain('仪表盘')
      expect(wrapper.text()).not.toContain('添加新订阅')
    })
  })

  describe('authenticated state', () => {
    it('shows dashboard and add subscription links when authenticated', () => {
      const wrapper = mountNavbar(true)

      expect(wrapper.text()).toContain('仪表盘')
      expect(wrapper.text()).toContain('添加新订阅')
    })

    it('shows an account link to auth.cqu.moe when authenticated', () => {
      const wrapper = mountNavbar(true)

      const accountLink = wrapper.find('a[href="https://auth.cqu.moe"]')
      expect(accountLink.exists()).toBe(true)
      expect(accountLink.text()).toContain('账户')
    })

    it('does not show an "https://auth.cqu.moe/login" link when authenticated', () => {
      const wrapper = mountNavbar(true)

      const loginLink = wrapper.find('a[href="https://auth.cqu.moe/login"]')
      expect(loginLink.exists()).toBe(false)
    })
  })

  it('always shows API docs link', () => {
    const unauthWrapper = mountNavbar(false)
    expect(unauthWrapper.text()).toContain('API 文档')

    const authWrapper = mountNavbar(true)
    expect(authWrapper.text()).toContain('API 文档')
  })

  it('theme toggle button exists with correct aria-label', () => {
    const wrapper = mountNavbar(false)

    const themeButton = wrapper.find('button[aria-label="切换主题"]')
    expect(themeButton.exists()).toBe(true)
  })

  it('renders logo link to home', async () => {
    await flushPromises()
    const wrapper = mountNavbar(false)

    const logoLink = wrapper.find('a[href="/"]')
    expect(logoLink.exists()).toBe(true)
    expect(logoLink.text()).toContain('CQU Schedule')
  })
})
