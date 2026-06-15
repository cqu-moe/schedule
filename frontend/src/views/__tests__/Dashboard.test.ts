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
    refreshSubscription: vi.fn().mockResolvedValue(undefined),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_SESSION = {
  user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
  caps: {
    sync: true,
    external: true,
    share: true,
    sub_limit: 5,
    share_limit: null,
    sync_interval: 60,
    manual_refresh: 5,
  },
  loaded: true,
  loading: false,
}

async function mountDashboard(subs = [mockSubscription()], sessionOverrides?: object) {
  mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList(subs))
  const result = await mountWithContext(Dashboard, {
    pinia: {
      initialState: {
        session: { ...DEFAULT_SESSION, ...sessionOverrides },
        config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
      },
    },
  })
  await flushPromises()
  return result
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dashboard view (v2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.refreshSubscription.mockResolvedValue(undefined)
    mockApi.deleteSubscription.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders "我的订阅" title', async () => {
    const { wrapper } = await mountDashboard()
    expect(wrapper.text()).toContain('我的订阅')
  })

  it('shows subscription count with limit (e.g. "(1/5)")', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    expect(wrapper.text()).toContain('(1/5)')
  })

  it('shows count without limit denominator when sub_limit is null', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription()],
      { caps: { ...DEFAULT_SESSION.caps, sub_limit: null } },
    )
    // Should show count but no slash
    expect(wrapper.text()).toContain('(1)')
    expect(wrapper.text()).not.toContain('/null')
  })

  it('shows "暂无订阅" when no subscriptions', async () => {
    const { wrapper } = await mountDashboard([])
    expect(wrapper.text()).toContain('暂无订阅')
  })

  it('shows source type badge "全部" for personal_all', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ source_type: 'personal_all' })])
    expect(wrapper.text()).toContain('全部')
  })

  it('shows "个人" badge for personal subscriptions', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ is_personal: true })])
    expect(wrapper.text()).toContain('个人')
  })

  it('shows session_name badge when present', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ session_name: '2025秋' })])
    expect(wrapper.text()).toContain('2025秋')
  })

  it('shows "同步于" date for synced subscriptions', async () => {
    const { wrapper } = await mountDashboard([
      mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' }),
    ])
    expect(wrapper.text()).toContain('同步于')
  })

  it('shows "尚未同步" for unsynced subscriptions NOT in pending refresh', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ last_synced_at: null })])
    expect(wrapper.text()).toContain('尚未同步')
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

  // ── Sub limit / usage ────────────────────────────────────────────────────────

  it('shows "已达订阅上限" when at sub_limit', async () => {
    const fiveSubs = Array.from({ length: 5 }, (_, i) =>
      mockSubscription({ id: `sub-${i}` }),
    )
    const { wrapper } = await mountDashboard(fiveSubs)
    expect(wrapper.text()).toContain('已达订阅上限')
  })

  it('"添加订阅" button is disabled when at sub_limit', async () => {
    const fiveSubs = Array.from({ length: 5 }, (_, i) =>
      mockSubscription({ id: `sub-${i}` }),
    )
    const { wrapper } = await mountDashboard(fiveSubs)
    const addBtn = wrapper.findAll('button').find(b => b.text().includes('添加订阅'))
    expect(addBtn?.attributes('disabled')).toBeDefined()
  })

  // ── Copy subscribe URL ────────────────────────────────────────────────────────

  it('copies ICS URL to clipboard when "复制订阅链接" is clicked', async () => {
    const sub = mockSubscription()
    const { wrapper } = await mountDashboard([sub])

    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('复制订阅链接'))
    expect(copyBtn).toBeDefined()
    await copyBtn!.trigger('click')
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/api/v2/calendar/link-token-abc/calendar.ics',
    )
  })

  it('shows "已复制" feedback after successful copy', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('复制订阅链接'))
    await copyBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已复制')
  })

  // ── Manual refresh ────────────────────────────────────────────────────────────

  it('calls api.refreshSubscription with sub.id when sync button is clicked', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])

    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(syncBtn).toBeDefined()
    await syncBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.refreshSubscription).toHaveBeenCalledWith('sub-uuid-123')
  })

  it('shows toast "已加入刷新队列" after manual refresh', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()
    expect(mockToast.success).toHaveBeenCalledWith('已加入刷新队列')
  })

  it('shows "同步中..." immediately after manual refresh (pending refresh tracker)', async () => {
    vi.useFakeTimers()
    const sub = mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([sub]))
    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: DEFAULT_SESSION,
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(syncBtn).toBeDefined()
    await syncBtn!.trigger('click')
    await flushPromises()

    // Should show 同步中... immediately (pendingRefresh tracker)
    expect(wrapper.text()).toContain('同步中...')
  })

  it('clears "同步中..." when poll detects changed last_synced_at', async () => {
    vi.useFakeTimers()
    const oldSyncedAt = '2026-03-01T10:00:00Z'
    const newSyncedAt = '2026-03-01T11:00:00Z'
    const sub = mockSubscription({ last_synced_at: oldSyncedAt })

    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([sub]))
    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: DEFAULT_SESSION,
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    // Trigger manual refresh
    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()

    // Verify 同步中... is shown before the poll
    expect(wrapper.text()).toContain('同步中...')

    // Now the poll returns an updated last_synced_at
    mockApi.getSubscriptions.mockResolvedValue(
      mockSubscriptionList([{ ...sub, last_synced_at: newSyncedAt }]),
    )

    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    // 同步中... should be cleared, now shows 同步于
    expect(wrapper.text()).not.toContain('同步中...')
    expect(wrapper.text()).toContain('同步于')
  })

  it('clears "同步中..." state after POLL_TIMEOUT (no sub stuck forever)', async () => {
    vi.useFakeTimers()
    const sub = mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' })
    // Poll always returns same last_synced_at (sync never completes)
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([sub]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: DEFAULT_SESSION,
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    // Trigger refresh to enter pending state
    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('同步中...')

    // Advance past POLL_TIMEOUT (30s)
    await vi.advanceTimersByTimeAsync(32000)
    await flushPromises()

    // After timeout, pendingRefresh cleared — shows 同步于 (the original synced date)
    expect(wrapper.text()).not.toContain('同步中...')
  })

  it('shows toast error when refresh subscription fails', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    mockApi.refreshSubscription.mockRejectedValueOnce({
      response: {
        data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '刷新超时' } } },
      },
    })
    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人') && !b.text().includes('中')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()
    expect(mockToast.error).toHaveBeenCalledWith('刷新超时')
  })

  // ── Sync all ──────────────────────────────────────────────────────────────────

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
    const { wrapper } = await mountDashboard([mockSubscription({ is_personal: true })])
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已同步')
  })

  it('"同步个人课表" button is disabled when there are no personal subscriptions (M1)', async () => {
    const exploreSub = mockSubscription({
      id: 'e-only',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    const { wrapper } = await mountDashboard([exploreSub])
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    expect(syncAllBtn).toBeDefined()
    expect(syncAllBtn!.attributes('disabled')).toBeDefined()
  })

  it('"同步个人课表" button is disabled when subscriptions list is empty (M1)', async () => {
    const { wrapper } = await mountDashboard([])
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    expect(syncAllBtn).toBeDefined()
    expect(syncAllBtn!.attributes('disabled')).toBeDefined()
  })

  it('handleSyncAll early-returns without toast when personalSubs is empty (M1)', async () => {
    const exploreSub = mockSubscription({ id: 'e-1', is_personal: false, source_type: 'instructor', source_name: '李四' })
    const { wrapper } = await mountDashboard([exploreSub])

    // Directly invoke handleSyncAll via the vm (bypassing disabled button guard)
    const vm = wrapper.vm as unknown as { handleSyncAll?: () => Promise<void> }
    // The function is not exposed on the public vm in script setup, but we can test
    // by clicking the disabled button — it should not call refreshSubscription
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.refreshSubscription).not.toHaveBeenCalled()
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  // ── Delete ────────────────────────────────────────────────────────────────────

  it('shows delete menu item for personal subscriptions', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ is_personal: true })])
    const menuDeleteItems = wrapper.findAll('div').filter(b => b.text().trim() === '删除')
    expect(menuDeleteItems.length).toBeGreaterThanOrEqual(1)
  })

  it('calls api.deleteSubscription with sub.id for non-personal subscription', async () => {
    const exploreSub = mockSubscription({
      id: 'e-sub-del',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    const { wrapper } = await mountDashboard([exploreSub])

    // Directly set deleteSubDialog to bypass stub dropdown interaction
    const vm = wrapper.vm as unknown as {
      deleteSubDialog: { id: string; name: string } | null
    }
    vm.deleteSubDialog = { id: 'e-sub-del', name: '李四' }
    await flushPromises()

    // AlertDialog stub renders <button>删除</button> via AlertDialogAction
    const actionBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    expect(actionBtns.length).toBeGreaterThanOrEqual(1)
    await actionBtns[0].trigger('click')
    await flushPromises()

    expect(mockApi.deleteSubscription).toHaveBeenCalledWith('e-sub-del')
  })

  it('shows success toast before reloading after delete', async () => {
    const exploreSub = mockSubscription({
      id: 'e-del-toast',
      is_personal: false,
      source_name: '王五',
    })
    const { wrapper } = await mountDashboard([exploreSub])

    const vm = wrapper.vm as unknown as {
      deleteSubDialog: { id: string; name: string } | null
    }
    vm.deleteSubDialog = { id: 'e-del-toast', name: '王五' }
    await flushPromises()

    const actionBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    await actionBtns[0].trigger('click')
    await flushPromises()

    expect(mockToast.success).toHaveBeenCalledWith('订阅已删除')
    // Success toast fires before reload
    const successCallOrder = mockToast.success.mock.invocationCallOrder[0]
    const reloadCallOrder = mockApi.getSubscriptions.mock.invocationCallOrder.at(-1) ?? Infinity
    expect(successCallOrder).toBeLessThan(reloadCallOrder)
  })

  // ── Load errors ───────────────────────────────────────────────────────────────

  it('shows toast error when initial load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValueOnce(new Error('network'))
    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: DEFAULT_SESSION,
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()
    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  // ── Polling ───────────────────────────────────────────────────────────────────

  it('starts polling after manual refresh and calls getSubscriptions again', async () => {
    vi.useFakeTimers()
    const sub = mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([sub]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          session: DEFAULT_SESSION,
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()

    const callsBefore = mockApi.getSubscriptions.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(mockApi.getSubscriptions.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  // ── Download links visible ────────────────────────────────────────────────────

  it('renders download items in dropdown for subscription with default link', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    // DropdownMenuContent stub renders unconditionally
    expect(wrapper.text()).toContain('下载 ICS 文件')
    expect(wrapper.text()).toContain('下载课表 JSON')
    expect(wrapper.text()).toContain('下载原始 JSON')
    expect(wrapper.text()).toContain('下载 CSV')
  })

  // ── FE-3: Share links ─────────────────────────────────────────────────────────

  it('shows "管理共享链接" menu item for every subscription', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    expect(wrapper.text()).toContain('管理共享链接')
  })

  it('"管理共享链接" menu item is clickable (not disabled)', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    // Under the DropdownMenuItem stub, items render as <div @click="...">
    const shareItem = wrapper.findAll('div').find(d => d.text().trim() === '管理共享链接')
    expect(shareItem).toBeDefined()
    // The item should not have disabled attribute
    expect(shareItem!.attributes('disabled')).toBeUndefined()
  })

  it('opens ShareLinksDialog when "管理共享链接" is clicked', async () => {
    const { wrapper } = await mountDashboard([mockSubscription()])
    const shareItem = wrapper.findAll('div').find(d => d.text().trim() === '管理共享链接')
    expect(shareItem).toBeDefined()
    await shareItem!.trigger('click')
    await flushPromises()
    // The stub renders only when open; the vm should now have shareLinksDialog.open = true
    const vm = wrapper.vm as unknown as { shareLinksDialog: { open: boolean; sub: unknown } }
    expect(vm.shareLinksDialog.open).toBe(true)
    expect(vm.shareLinksDialog.sub).not.toBeNull()
  })
})
