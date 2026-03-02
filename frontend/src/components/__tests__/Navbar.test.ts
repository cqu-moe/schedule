import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import Navbar from '@/components/Navbar.vue'

vi.mock('@/api', () => ({
  default: {
    register: vi.fn(),
    getUserInfo: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getCaptchaConfig: vi.fn(),
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

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'Home', component: { template: '<div>Home</div>' } },
      { path: '/login', name: 'Login', component: { template: '<div>Login</div>' } },
      { path: '/register', name: 'Register', component: { template: '<div>Register</div>' } },
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
        ? { auth: { token: 'tok', userInfo: null, loading: false } }
        : {},
    })

    return mount(Navbar, {
      global: {
        plugins: [pinia, router],
      },
    })
  }

  describe('unauthenticated state', () => {
    it('shows register and login links when not authenticated', () => {
      const wrapper = mountNavbar(false)

      expect(wrapper.text()).toContain('注册')
      expect(wrapper.text()).toContain('登录')
    })

    it('does not show dashboard, add, or logout links when not authenticated', () => {
      const wrapper = mountNavbar(false)

      expect(wrapper.text()).not.toContain('仪表盘')
      expect(wrapper.text()).not.toContain('添加新订阅')
      expect(wrapper.text()).not.toContain('退出登录')
    })
  })

  describe('authenticated state', () => {
    it('shows dashboard, add, and logout when authenticated', () => {
      const wrapper = mountNavbar(true)

      expect(wrapper.text()).toContain('仪表盘')
      expect(wrapper.text()).toContain('添加新订阅')
      expect(wrapper.text()).toContain('退出登录')
    })

    it('does not show register or login links when authenticated', () => {
      const wrapper = mountNavbar(true)

      // "退出登录" contains "登录" as a substring, so check for exact link text via router-links
      const links = wrapper.findAll('a')
      const linkTexts = links.map((l) => l.text().trim())
      expect(linkTexts).not.toContain('注册')
      expect(linkTexts).not.toContain('登录')
    })
  })

  it('always shows API docs link', () => {
    const unauthWrapper = mountNavbar(false)
    expect(unauthWrapper.text()).toContain('API 文档')

    const authWrapper = mountNavbar(true)
    expect(authWrapper.text()).toContain('API 文档')
  })

  it('logout clears auth and navigates to /', async () => {
    // Navigate away from home first so we can verify the redirect
    await router.push('/dashboard')

    const wrapper = mountNavbar(true)

    const logoutButton = wrapper.findAll('button').find((b) => b.text().includes('退出登录'))!
    expect(logoutButton).toBeTruthy()

    await logoutButton.trigger('click')

    // Wait for the async router.push('/') inside handleLogout to complete
    await flushPromises()

    // Auth store token should be cleared (logout was called)
    const { useAuthStore } = await import('@/stores/auth.js')
    const authStore = useAuthStore()
    expect(authStore.token).toBe('')

    // Should navigate to /
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('theme toggle button exists with correct aria-label', () => {
    const wrapper = mountNavbar(false)

    const themeButton = wrapper.find('button[aria-label="切换主题"]')
    expect(themeButton.exists()).toBe(true)
  })
})
