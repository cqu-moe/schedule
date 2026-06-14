// TODO(FE-2): full Dashboard test rewrite when the v2 Dashboard UI (links,
// share management, danger zone) is implemented. This file covers the minimal
// FE-1 shim of Dashboard.vue.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithContext, mockSubscription, mockSubscriptionList } from '@/test-utils'

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn() }
  const mockApi = {
    getMe: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], count: 0 }),
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
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))
vi.mock('vue-sonner', () => ({ toast: mockToast }))

const { default: Dashboard } = await import('@/views/Dashboard.vue')

async function mountDashboard(subs = [mockSubscription()]) {
  mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList(subs))
  mockApi.refreshSubscription.mockResolvedValue(undefined)
  const result = await mountWithContext(Dashboard, {
    pinia: {
      initialState: {
        session: {
          user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
          caps: { sync: true, external: true, share: true, sub_limit: 5, share_limit: null, sync_interval: 60, manual_refresh: 5 },
          loaded: true,
          loading: false,
        },
        config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
      },
    },
  })
  await flushPromises()
  return result
}

describe('Dashboard view (FE-1 shim)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('risk_warning_acknowledged', 'true')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders "我的订阅" title', async () => {
    const { wrapper } = await mountDashboard()
    expect(wrapper.text()).toContain('我的订阅')
  })

  it('shows subscription count when subscriptions exist', async () => {
    const { wrapper } = await mountDashboard()
    expect(wrapper.text()).toContain('(1)')
  })

  it('shows "暂无订阅" when no subscriptions', async () => {
    const { wrapper } = await mountDashboard([])
    expect(wrapper.text()).toContain('暂无订阅')
  })

  it('shows source type badge "全部" for personal_all', async () => {
    const { wrapper } = await mountDashboard([
      mockSubscription({ source_type: 'personal_all' }),
    ])
    expect(wrapper.text()).toContain('全部')
  })

  it('shows "同步于" date for synced subscriptions', async () => {
    const { wrapper } = await mountDashboard([
      mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' }),
    ])
    expect(wrapper.text()).toContain('同步于')
  })

  it('shows "同步中..." for unsynced subscriptions when polling is active', async () => {
    vi.useFakeTimers()
    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: { user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' }, caps: {}, loaded: true, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('同步中...')
  })

  it('shows "尚未同步" for unsynced subscriptions after polling timeout', async () => {
    vi.useFakeTimers()
    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: { user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' }, caps: {}, loaded: true, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    await vi.advanceTimersByTimeAsync(32000)
    await flushPromises()

    expect(wrapper.text()).toContain('尚未同步')
  })

  it('calls api.refreshSubscription with sub.id when sync button is clicked', async () => {
    const { wrapper } = await mountDashboard()

    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(syncBtn).toBeDefined()
    await syncBtn!.trigger('click')
    await flushPromises()

    // v2: uses sub.id (UUID), not calendar_token
    expect(mockApi.refreshSubscription).toHaveBeenCalledWith('sub-uuid-123')
  })

  it('sync all only refreshes personal subscriptions', async () => {
    const personalSub = mockSubscription({ id: 'p-sub-1', is_personal: true })
    const exploreSub = mockSubscription({
      id: 'e-sub-1',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    const { wrapper } = await mountDashboard([personalSub, exploreSub])

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    expect(syncAllBtn).toBeDefined()
    await syncAllBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.refreshSubscription).toHaveBeenCalledTimes(1)
    expect(mockApi.refreshSubscription).toHaveBeenCalledWith('p-sub-1')
    expect(mockApi.refreshSubscription).not.toHaveBeenCalledWith('e-sub-1')
  })

  it('shows "已同步" after sync all succeeds', async () => {
    const { wrapper } = await mountDashboard()

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已同步')
  })

  it('does not show delete button for personal subscriptions', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ is_personal: true })])

    const menuDeleteItems = wrapper.findAll('div').filter(b => b.text().trim() === '删除')
    expect(menuDeleteItems.length).toBe(0)
  })

  it('calls api.deleteSubscription with sub.id for non-personal subscription', async () => {
    const exploreSub = mockSubscription({
      id: 'e-sub-del',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    mockApi.deleteSubscription.mockResolvedValue(undefined)
    const { wrapper } = await mountDashboard([exploreSub])

    // The AlertDialog stub (test-setup.ts) renders its content unconditionally —
    // the :open prop is not checked, so the AlertDialogAction <button> is always
    // in the DOM. However, handleDeleteSub guards against null deleteSubDialog.
    //
    // We bypass the DropdownMenuItem click (which is tricky to propagate through
    // stubs) and directly set deleteSubDialog on the component instance, then
    // trigger the AlertDialogAction button.
    const vm = wrapper.vm as unknown as { deleteSubDialog: { id: string; name: string } | null }
    vm.deleteSubDialog = { id: 'e-sub-del', name: '李四' }
    await flushPromises()

    // AlertDialogAction stub: <button @click="$emit('click')">删除</button>
    const actionBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    expect(actionBtns.length).toBeGreaterThanOrEqual(1)
    await actionBtns[0].trigger('click')
    await flushPromises()

    expect(mockApi.deleteSubscription).toHaveBeenCalledWith('e-sub-del')
  })

  it('shows toast error when initial load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))

    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: { user: null, caps: null, loaded: true, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  it('shows toast error when refresh subscription fails', async () => {
    const { wrapper } = await mountDashboard()
    mockApi.refreshSubscription.mockRejectedValue({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '刷新超时' } } } },
    })

    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人') && !b.text().includes('中')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('刷新超时')
  })

  it('starts polling for unsynced subscriptions and calls getSubscriptions again', async () => {
    vi.useFakeTimers()
    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))

    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: { user: null, caps: null, loaded: true, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    const initialCallCount = mockApi.getSubscriptions.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(mockApi.getSubscriptions.mock.calls.length).toBeGreaterThan(initialCallCount)
  })

  it('shows correct source type labels for different types', async () => {
    const subs = [
      mockSubscription({ id: 't1', source_type: 'personal_courses' }),
      mockSubscription({ id: 't2', source_type: 'personal_exams', is_personal: false }),
    ]
    const { wrapper } = await mountDashboard(subs)
    expect(wrapper.text()).toContain('课程')
    expect(wrapper.text()).toContain('考试')
  })
})
