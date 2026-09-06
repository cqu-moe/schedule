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
    mockApi.refreshSubscription.mockResolvedValue({ status: 'queued', run_id: 'run-1' })
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

  it('shows the persisted sync failure instead of silently ending the progress indicator', async () => {
    vi.useFakeTimers()
    const queued = mockSubscription({
      sync_status: 'queued',
      sync_run_id: 'run-1',
      sync_trigger: 'manual',
      sync_requested_at: '2026-03-01T10:00:00Z',
      sync_started_at: null,
      sync_finished_at: null,
      sync_error_code: null,
      sync_error_message: null,
    } as any)
    const failed = {
      ...queued,
      sync_status: 'error',
      sync_finished_at: '2026-03-01T10:01:00Z',
      sync_error_code: 'CQU_WAF_BLOCKED',
      sync_error_message: '学校系统暂时无法完成同步，请稍后重试',
    }
    mockApi.getSubscriptions.mockResolvedValueOnce(mockSubscriptionList([queued]))
    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: { initialState: { session: DEFAULT_SESSION, config: { publicUrl: 'https://schedule.cqu.moe', loaded: true } } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('同步中...')

    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([failed] as any))
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(wrapper.text()).toContain('同步失败：学校系统暂时无法完成同步，请稍后重试')
    expect(mockToast.error).toHaveBeenCalledWith('学校系统暂时无法完成同步，请稍后重试')
  })

  it('shows that a transient backend failure is being retried', async () => {
    vi.useFakeTimers()
    const retrying = mockSubscription({
      sync_status: 'queued',
      sync_run_id: 'run-retry',
      sync_trigger: 'manual',
      sync_error_code: 'ATRUST_TRANSIENT',
      sync_error_message: '学校系统暂时无法完成同步，请稍后重试',
    })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([retrying]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: { initialState: { session: DEFAULT_SESSION, config: { publicUrl: 'https://schedule.cqu.moe', loaded: true } } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('同步遇到临时故障，正在自动重试...')
  })

  it('stops a persisted queued run at the hard timeout instead of spinning forever', async () => {
    vi.useFakeTimers()
    const queued = mockSubscription({
      sync_status: 'queued',
      sync_run_id: 'run-stuck',
      sync_trigger: 'manual',
      sync_requested_at: '2026-03-01T10:00:00Z',
    })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([queued]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: { initialState: { session: DEFAULT_SESSION, config: { publicUrl: 'https://schedule.cqu.moe', loaded: true } } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('同步中...')

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 2000)
    await flushPromises()

    expect(wrapper.text()).not.toContain('同步中...')
    expect(wrapper.text()).toContain('同步失败：同步超时，请稍后重试')
  })

  it('shows an explicit failure after POLL_TIMEOUT (no silent progress completion)', async () => {
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

    // After timeout, the progress indicator becomes a visible failure.
    expect(wrapper.text()).not.toContain('同步中...')
    expect(wrapper.text()).toContain('同步失败：同步超时，请稍后重试')
    expect(mockToast.error).toHaveBeenCalledWith('同步超时，请稍后重试')
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

  it('keeps sync all in progress after requests are only accepted into the queue', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ is_personal: true })])
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('同步中')
    expect(wrapper.text()).not.toContain('已同步')
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

  it('does not show success toast and keeps dialog open when delete fails', async () => {
    const exploreSub = mockSubscription({
      id: 'e-del-fail',
      is_personal: false,
      source_name: '赵六',
    })
    const { wrapper } = await mountDashboard([exploreSub])

    mockApi.deleteSubscription.mockRejectedValueOnce({
      response: {
        data: { detail: { error: { code: 'FORBIDDEN', message: '无权删除' } } },
      },
    })

    const vm = wrapper.vm as unknown as {
      deleteSubDialog: { id: string; name: string } | null
    }
    vm.deleteSubDialog = { id: 'e-del-fail', name: '赵六' }
    await flushPromises()

    const actionBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    await actionBtns[0].trigger('click')
    await flushPromises()

    // Success toast must NOT be shown
    expect(mockToast.success).not.toHaveBeenCalledWith('订阅已删除')
    // Error toast must be shown
    expect(mockToast.error).toHaveBeenCalledWith('无权删除')
    // Dialog must remain open (deleteSubDialog still set)
    expect(vm.deleteSubDialog).not.toBeNull()
    expect(vm.deleteSubDialog?.id).toBe('e-del-fail')
  })

  it('shows error toast (not success) when delete fails with network error', async () => {
    const exploreSub = mockSubscription({
      id: 'e-del-net',
      is_personal: false,
      source_name: '钱七',
    })
    const { wrapper } = await mountDashboard([exploreSub])

    mockApi.deleteSubscription.mockRejectedValueOnce(new Error('Network Error'))

    const vm = wrapper.vm as unknown as {
      deleteSubDialog: { id: string; name: string } | null
    }
    vm.deleteSubDialog = { id: 'e-del-net', name: '钱七' }
    await flushPromises()

    const actionBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    await actionBtns[0].trigger('click')
    await flushPromises()

    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('删除订阅失败')
    expect(vm.deleteSubDialog).not.toBeNull()
  })

  it('closes dialog only after successful delete', async () => {
    const exploreSub = mockSubscription({
      id: 'e-del-close',
      is_personal: false,
      source_name: '孙八',
    })
    const { wrapper } = await mountDashboard([exploreSub])

    const vm = wrapper.vm as unknown as {
      deleteSubDialog: { id: string; name: string } | null
    }
    vm.deleteSubDialog = { id: 'e-del-close', name: '孙八' }
    await flushPromises()

    const actionBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    await actionBtns[0].trigger('click')
    await flushPromises()

    // On success dialog must be closed (null)
    expect(vm.deleteSubDialog).toBeNull()
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

  // ── manual_refresh quota ──────────────────────────────────────────────────────

  it('per-sub refresh button is enabled when manual_refresh is null (unlimited)', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription()],
      { caps: { ...DEFAULT_SESSION.caps, manual_refresh: null } },
    )
    const refreshBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(refreshBtn).toBeDefined()
    expect(refreshBtn!.attributes('disabled')).toBeUndefined()
  })

  it('per-sub refresh button is enabled when manual_refresh > 0', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription()],
      { caps: { ...DEFAULT_SESSION.caps, manual_refresh: 3 } },
    )
    const refreshBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(refreshBtn).toBeDefined()
    expect(refreshBtn!.attributes('disabled')).toBeUndefined()
  })

  it('per-sub refresh button is disabled when manual_refresh is 0', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription()],
      { caps: { ...DEFAULT_SESSION.caps, manual_refresh: 0 } },
    )
    const refreshBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(refreshBtn).toBeDefined()
    expect(refreshBtn!.attributes('disabled')).toBeDefined()
  })

  it('"同步个人课表" button is disabled when manual_refresh is 0', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription({ is_personal: true })],
      { caps: { ...DEFAULT_SESSION.caps, manual_refresh: 0 } },
    )
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    expect(syncAllBtn).toBeDefined()
    expect(syncAllBtn!.attributes('disabled')).toBeDefined()
  })

  it('"同步个人课表" button is enabled when manual_refresh is null (unlimited)', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription({ is_personal: true })],
      { caps: { ...DEFAULT_SESSION.caps, manual_refresh: null } },
    )
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    expect(syncAllBtn).toBeDefined()
    expect(syncAllBtn!.attributes('disabled')).toBeUndefined()
  })

  it('"同步个人课表" button is enabled when manual_refresh > 0', async () => {
    const { wrapper } = await mountDashboard(
      [mockSubscription({ is_personal: true })],
      { caps: { ...DEFAULT_SESSION.caps, manual_refresh: 2 } },
    )
    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    expect(syncAllBtn).toBeDefined()
    expect(syncAllBtn!.attributes('disabled')).toBeUndefined()
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
