import { defineComponent, h, nextTick, type Ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DefaultSubscriptionsResponse } from '@/types/api'

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  getSubscriptions: vi.fn(),
  ensureDefaultSubscriptions: vi.fn(),
  redirect: { fn: vi.fn() },
}))

vi.mock('@/api', () => ({
  default: {
    getMe: mocks.getMe,
    getSubscriptions: mocks.getSubscriptions,
    ensureDefaultSubscriptions: mocks.ensureDefaultSubscriptions,
  },
  redirect: mocks.redirect,
}))

import { usePersonalSetup, type PersonalSetupController } from '@/composables/usePersonalSetup'

const fullCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: true,
  sub_limit: 10,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
}

const created: DefaultSubscriptionsResponse = {
  status: 'created',
  subscription_ids: ['a', 'b', 'c'],
  run_id: 'run-1',
  dispatch_status: 'sent',
}

let router: Router
let wrapper: VueWrapper
let controller: PersonalSetupController

async function mountController(initialRoute: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'Dashboard', component: { render: () => null } },
      { path: '/add', name: 'Add', component: { render: () => null } },
    ],
  })
  await router.push(initialRoute)
  await router.isReady()
  const Harness = defineComponent({
    setup() {
      controller = usePersonalSetup()
      return () => h('div')
    },
  })
  wrapper = mount(Harness, { global: { plugins: [pinia, router] } })
  await nextTick()
}

beforeEach(() => {
  wrapper?.unmount()
  vi.clearAllMocks()
  mocks.getMe.mockResolvedValue({
    user: { id: 'user-1', name: '测试', email: 'u@example.com', role: 'user' },
    caps: { calendar: fullCaps },
    cquBindStatus: 'active',
  })
  mocks.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0, personal_setup: null })
  mocks.ensureDefaultSubscriptions.mockResolvedValue(created)
})

describe('usePersonalSetup', () => {
  it('does nothing without setup=1, even when list metadata exists', async () => {
    await mountController('/dashboard')
    await controller.begin()
    expect(mocks.getMe).not.toHaveBeenCalled()
    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
  })

  it('coalesces repeated begin calls into one defaults POST', async () => {
    let resolve!: (value: DefaultSubscriptionsResponse) => void
    mocks.ensureDefaultSubscriptions.mockReturnValue(new Promise((done) => { resolve = done }))
    await mountController('/dashboard?setup=1')

    const first = controller.begin()
    const second = controller.begin()
    await flushPromises()
    expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(1)
    resolve(created)
    await Promise.all([first, second])
  })

  it('removes setup without POST when sync is not enabled', async () => {
    mocks.getMe.mockResolvedValueOnce({
      user: { id: 'user-1', name: '测试', email: 'u@example.com', role: 'user' },
      caps: { calendar: { ...fullCaps, sync: false } },
      cquBindStatus: 'unbound',
    })
    await mountController('/add?setup=1&from=menu#personal')
    await controller.begin()

    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/add?from=menu#personal')
  })

  it('redirects an explicitly unbound session to Auth binding without POST', async () => {
    mocks.getMe.mockResolvedValueOnce({
      user: { id: 'user-1', name: '测试', email: 'u@example.com', role: 'user' },
      caps: { calendar: fullCaps },
      cquBindStatus: 'revoked',
    })
    await mountController('/add?setup=1&from=menu')
    await controller.begin()

    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    expect(mocks.redirect.fn).toHaveBeenCalledOnce()
    const authUrl = new URL(mocks.redirect.fn.mock.calls[0][0])
    expect(authUrl.pathname).toBe('/cqu/bind')
    expect(authUrl.searchParams.get('redirect')).toContain('/add?setup=1&from=menu')
  })

  it('uses refreshed active session state, creates defaults, and reloads the list', async () => {
    let resolve!: (value: DefaultSubscriptionsResponse) => void
    mocks.ensureDefaultSubscriptions.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    await mountController('/dashboard?setup=1')
    const promise = controller.begin()
    await flushPromises()
    expect((controller.preparing as Ref<boolean>).value).toBe(true)
    resolve(created)
    await promise

    expect(mocks.getMe).toHaveBeenCalledTimes(1)
    expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(1)
    expect(mocks.getSubscriptions).toHaveBeenCalledWith(true)
    expect((controller.startedThisVisit as Ref<boolean>).value).toBe(true)
    expect((controller.error as Ref<string | null>).value).toBeNull()
    expect(router.currentRoute.value.query.setup).toBeUndefined()
  })

  it('keeps unknown binding status local and exposes a retryable defaults error', async () => {
    mocks.getMe.mockResolvedValueOnce({
      user: { id: 'user-1', name: '测试', email: 'u@example.com', role: 'user' },
      caps: { calendar: fullCaps },
    })
    mocks.ensureDefaultSubscriptions.mockRejectedValueOnce({
      response: { data: { detail: { error: {
        code: 'CQU_BINDING_STATUS_UNKNOWN',
        message: '暂时无法确认统一认证绑定状态',
      } } } },
    })
    await mountController('/dashboard?setup=1')
    await controller.begin()

    expect(mocks.redirect.fn).not.toHaveBeenCalled()
    expect((controller.error as Ref<string | null>).value).toContain('暂时无法确认统一认证绑定状态')
    expect(router.currentRoute.value.query.setup).toBe('1')
  })

  it('keeps setup after failure and succeeds on an explicit retry', async () => {
    mocks.ensureDefaultSubscriptions
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(created)
    await mountController('/dashboard?setup=1&from=auth#top')

    await controller.begin()
    expect((controller.error as Ref<string | null>).value).toBeTruthy()
    expect(router.currentRoute.value.query.setup).toBe('1')
    await controller.begin()

    expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(2)
    expect((controller.error as Ref<string | null>).value).toBeNull()
    expect(router.currentRoute.value.fullPath).toBe('/dashboard?from=auth#top')
  })

  it('sends a newly created Add visit to Dashboard while preserving other query and hash', async () => {
    await mountController('/add?setup=1&from=menu#personal')
    await controller.begin()
    expect(router.currentRoute.value.fullPath).toBe('/dashboard?from=menu#personal')
  })

  it('keeps an existing account on Add and only removes setup', async () => {
    mocks.ensureDefaultSubscriptions.mockResolvedValueOnce({
      status: 'existing',
      subscription_ids: [],
      run_id: null,
      dispatch_status: 'sent',
    })
    await mountController('/add?setup=1&from=menu')
    await controller.begin()
    expect(router.currentRoute.value.fullPath).toBe('/add?from=menu')
  })
})
