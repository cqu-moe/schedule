import { mount, type MountingOptions } from '@vue/test-utils'
import { createTestingPinia, type TestingOptions } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import { vi } from 'vitest'
import type { Component } from 'vue'
import type { Subscription, SubscriptionList, SessionUser, CalendarCaps, MeResponse, PersonalSetupSummary } from '@/types/api'
import { RouteNames } from '@/router'

// ---- Mock data factories ----

export function mockSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-uuid-001',
    name: '张三',
    email: 'zhangsan@example.com',
    role: 'student',
    ...overrides,
  }
}

export function mockCalendarCaps(overrides: Partial<CalendarCaps> = {}): CalendarCaps {
  return {
    sync: true,
    external: true,
    share: true,
    change_notification: true,
    sub_limit: 5,
    share_limit: 10,
    sync_interval: 60,
    manual_refresh: 5,
    ...overrides,
  }
}

export function mockMeResponse(overrides: Partial<{ user: Partial<SessionUser>; caps: Partial<CalendarCaps> }> = {}): MeResponse {
  return {
    user: mockSessionUser(overrides.user),
    caps: { calendar: mockCalendarCaps(overrides.caps) },
  }
}

export function mockSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-uuid-123',
    user_id: 'user-uuid-001',
    source_type: 'personal_all',
    source_id: 'user-uuid-001',
    source_name: '张三',
    session_id: 'session-001',
    session_name: '2025秋',
    semester_start: '2025-09-01',
    is_personal: true,
    last_synced_at: '2026-03-01T10:00:00Z',
    sync_status: 'success',
    sync_run_id: null,
    sync_trigger: null,
    sync_requested_at: null,
    sync_started_at: null,
    sync_finished_at: '2026-03-01T10:00:00Z',
    sync_error_code: null,
    sync_error_message: null,
    manual_refresh_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-03-01T10:00:00Z',
    links: [
      {
        id: 'link-uuid-001',
        token: 'link-token-abc',
        label: null,
        formats: ['ics', 'origin_json', 'data_json', 'csv', 'web'],
        is_default: true,
      },
    ],
    ...overrides,
  }
}

export function mockSubscriptionList(
  subs: Subscription[] = [mockSubscription()],
  count?: number,
  personalSetup: PersonalSetupSummary | null = null,
): SubscriptionList {
  return { subscriptions: subs, count: count ?? subs.length, personal_setup: personalSetup }
}

// ---- Router for tests ----

const routes = [
  { path: '/', name: RouteNames.Home, component: { template: '<div>Home</div>' } },
  { path: '/dashboard', name: RouteNames.Dashboard, component: { template: '<div>Dashboard</div>' } },
  { path: '/add', name: RouteNames.Add, component: { template: '<div>Add</div>' } },
  { path: '/api-docs', name: RouteNames.ApiDocs, component: { template: '<div>Docs</div>' } },
  { path: '/changelog', name: RouteNames.Changelog, component: { template: '<div>Changelog</div>' } },
  { path: '/view/:token', name: RouteNames.View, component: { template: '<div>View</div>' } },
  { path: '/calendar/:sub_token', redirect: (to: any) => ({ path: `/view/${to.params.sub_token}` }) },
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

  const { stubs: customStubs, ...restGlobal } = mountOpts.global || {}

  const wrapper = mount(component, {
    ...mountOpts,
    global: {
      plugins: [pinia, router],
      ...restGlobal,
      stubs: {
        Navbar: { template: '<nav data-testid="navbar" />' },
        QrcodeModal: { template: '<div data-testid="qrcode-modal" />' },
        ...(customStubs as Record<string, any> || {}),
      },
    },
  })

  await router.isReady()
  return { wrapper, router, pinia }
}
