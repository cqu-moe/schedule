import { mount, type MountingOptions } from '@vue/test-utils'
import { createTestingPinia, type TestingOptions } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import { vi } from 'vitest'
import type { Component } from 'vue'

// ---- Mock data factories ----

export function mockUserInfo(overrides = {}) {
  return {
    student_id: '20210001',
    calendar_token: 'test-token-abc123',
    oauth_expires_at: '2026-03-02T12:00:00Z',
    last_synced_at: '2026-03-01T10:00:00Z',
    ...overrides,
  }
}

export function mockSubscription(overrides = {}) {
  return {
    calendar_token: 'sub-token-123',
    source_type: 'personal_all',
    source_id: '20210001',
    source_name: '张三',
    is_personal: true,
    session_name: '2025秋',
    last_synced_at: '2026-03-01T10:00:00Z',
    subscription_url: 'https://schedule.cqu.moe/api/v1/subscriptions/sub-token-123/calendar.ics',
    ...overrides,
  }
}

export function mockSubscriptionList(subs = [mockSubscription()], max = 5) {
  return { subscriptions: subs, max }
}

export function mockSearchResult(overrides = {}) {
  return {
    id: 'result-1',
    name: '高等数学',
    extra: '数学学院',
    ...overrides,
  }
}

// ---- Mock API ----

export function createMockApi() {
  return {
    register: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getCaptchaConfig: vi.fn().mockResolvedValue({ enabled: false, sitekey: '' }),
    getUserInfo: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn().mockResolvedValue(mockSubscriptionList([])),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
  }
}

// ---- Router for tests ----

const routes = [
  { path: '/', name: 'Home', component: { template: '<div>Home</div>' } },
  { path: '/login', name: 'Login', component: { template: '<div>Login</div>' } },
  { path: '/register', name: 'Register', component: { template: '<div>Register</div>' } },
  { path: '/recover', name: 'Recover', component: { template: '<div>Recover</div>' } },
  { path: '/dashboard', name: 'Dashboard', component: { template: '<div>Dashboard</div>' }, meta: { requiresAuth: true } },
  { path: '/add', name: 'Add', component: { template: '<div>Add</div>' }, meta: { requiresAuth: true } },
  { path: '/api-docs', name: 'ApiDocs', component: { template: '<div>Docs</div>' } },
]

export function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  })
}

// ---- Mount helper ----

interface TestMountOptions extends MountingOptions<any> {
  pinia?: TestingOptions
  initialRoute?: string
}

export async function mountWithContext(
  component: Component,
  options: TestMountOptions = {},
) {
  const { pinia: piniaOpts, initialRoute, ...mountOpts } = options

  const router = createTestRouter()
  if (initialRoute) {
    router.push(initialRoute)
    await router.isReady()
  }

  const pinia = createTestingPinia({
    createSpy: vi.fn,
    stubActions: false,
    ...piniaOpts,
  })

  const wrapper = mount(component, {
    ...mountOpts,
    global: {
      plugins: [pinia, router],
      stubs: {
        Navbar: { template: '<nav data-testid="navbar" />' },
        RiskWarning: { template: '<div data-testid="risk-warning" />' },
        QrcodeModal: { template: '<div data-testid="qrcode-modal" />' },
        ...(mountOpts.global?.stubs as Record<string, any> || {}),
      },
      ...mountOpts.global,
    },
  })

  await router.isReady()
  return { wrapper, router, pinia }
}
