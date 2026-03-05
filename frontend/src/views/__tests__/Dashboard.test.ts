import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithContext, mockSubscription, mockSubscriptionList } from '@/test-utils'

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn() }
  const mockApi = {
    register: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getCaptchaConfig: vi.fn().mockResolvedValue({ enabled: false, sitekey: '' }),
    getUserInfo: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], max: 5 }),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))
vi.mock('vue-sonner', () => ({ toast: mockToast }))

const { default: Dashboard } = await import('@/views/Dashboard.vue')

async function mountDashboard(subs = [mockSubscription()]) {
  mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList(subs))
  mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
  mockApi.refreshSubscription.mockResolvedValue({})
  const result = await mountWithContext(Dashboard, {
    pinia: {
      initialState: {
        auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
        config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
      },
    },
  })
  await flushPromises()
  return result
}

describe('Dashboard view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('risk_warning_acknowledged', 'true')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // 1. Renders subscription list with title and count
  it('renders "我的订阅" title and count "(1/5)"', async () => {
    const { wrapper } = await mountDashboard()

    expect(wrapper.text()).toContain('我的订阅')
    expect(wrapper.text()).toContain('(1/5)')
  })

  // 2. Shows empty state when no subscriptions
  it('shows "暂无订阅" when no subscriptions', async () => {
    const { wrapper } = await mountDashboard([])

    expect(wrapper.text()).toContain('暂无订阅')
  })

  // 3. Shows source type badge
  it('shows source type badge "全部" for personal_all', async () => {
    const { wrapper } = await mountDashboard([
      mockSubscription({ source_type: 'personal_all' }),
    ])

    expect(wrapper.text()).toContain('全部')
  })

  // 4. Shows synced date
  it('shows "同步于" + date for synced subscriptions', async () => {
    const { wrapper } = await mountDashboard([
      mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' }),
    ])

    expect(wrapper.text()).toContain('同步于')
  })

  // 5. Shows unsynced status — polling auto-starts so it shows "同步中..."
  it('shows "同步中..." for unsynced subscriptions when polling is active', async () => {
    vi.useFakeTimers()

    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('同步中...')
  })

  // Shows "尚未同步" after polling times out
  it('shows "尚未同步" for unsynced subscriptions after polling timeout', async () => {
    vi.useFakeTimers()

    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    // Advance past the 30s polling timeout
    await vi.advanceTimersByTimeAsync(32000)
    await flushPromises()

    expect(wrapper.text()).toContain('尚未同步')
  })

  // 6. Copy URL calls navigator.clipboard.writeText
  it('copies URL to clipboard when copy button is clicked', async () => {
    const { wrapper } = await mountDashboard()

    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('复制'))
    expect(copyBtn).toBeDefined()
    await copyBtn!.trigger('click')
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/api/v1/subscriptions/sub-token-123/calendar.ics',
    )
  })

  // 7. Sync button calls api.refreshSubscription
  it('calls api.refreshSubscription when sync button is clicked', async () => {
    const { wrapper } = await mountDashboard()

    // Find the per-subscription "同步" button (not "同步个人课表")
    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('个人')),
    )
    expect(syncBtn).toBeDefined()
    await syncBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.refreshSubscription).toHaveBeenCalledWith('test-token', 'sub-token-123')
  })

  // 8. Sync all only syncs personal subscriptions
  it('sync all only syncs personal subscriptions (is_personal: true)', async () => {
    const personalSub = mockSubscription({ calendar_token: 'personal-1', is_personal: true })
    const exploreSub = mockSubscription({
      calendar_token: 'explore-1',
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
    expect(mockApi.refreshSubscription).toHaveBeenCalledWith('test-token', 'personal-1')
    expect(mockApi.refreshSubscription).not.toHaveBeenCalledWith('test-token', 'explore-1')
  })

  // 9. Shows success state on sync all button
  it('shows "已同步" after sync all', async () => {
    const { wrapper } = await mountDashboard()

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已同步')
  })

  // 10. Delete subscription calls api.deleteSubscription for non-personal
  it('delete button calls api.deleteSubscription for non-personal subscription', async () => {
    const exploreSub = mockSubscription({
      calendar_token: 'explore-1',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    mockApi.deleteSubscription.mockResolvedValue({})
    const { wrapper } = await mountDashboard([exploreSub])

    // Find the delete action button within the AlertDialog (the AlertDialogAction emits click)
    const deleteActionBtn = wrapper.findAll('button').find(
      b => b.text() === '删除' && b.element.closest('[class*="destructive"]') !== null,
    )
    // The AlertDialog stub renders the AlertDialogAction as a button with text "删除"
    // There should be two "删除" buttons: the trigger and the action
    const deleteButtons = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1)
    // Click the last one (the action inside AlertDialog)
    await deleteButtons[deleteButtons.length - 1].trigger('click')
    await flushPromises()

    expect(mockApi.deleteSubscription).toHaveBeenCalledWith('test-token', 'explore-1')
  })

  // 11. No delete button for personal subscriptions
  it('does not show delete button for personal subscriptions', async () => {
    const personalSub = mockSubscription({ is_personal: true })
    const { wrapper } = await mountDashboard([personalSub])

    // Personal subs should not have a delete button (AlertDialog is v-if="!sub.is_personal")
    const deleteButtons = wrapper.findAll('button').filter(
      b => b.text().trim() === '删除' && !b.text().includes('账号'),
    )
    // The only "删除" should be in the danger zone "删除账号"
    // There should be no standalone "删除" button for the subscription
    const subDeleteButtons = deleteButtons.filter(b => !b.text().includes('账号'))
    expect(subDeleteButtons.length).toBe(0)
  })

  // 12. Export opens window.open with correct URL
  it('export ICS opens window.open with correct URL', async () => {
    const { wrapper } = await mountDashboard()

    // Find the DropdownMenuItem stub for ICS export (it emits click)
    const menuItems = wrapper.findAll('div').filter(b => b.text().trim() === 'ICS 日历')
    expect(menuItems.length).toBeGreaterThanOrEqual(1)
    await menuItems[0].trigger('click')
    await flushPromises()

    expect(window.open).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/api/v1/subscriptions/sub-token-123/calendar.ics',
      '_blank',
      'noopener,noreferrer',
    )
  })

  // 13. Polling starts for pending subscriptions
  it('starts polling for unsynced subscriptions and calls getSubscriptions again', async () => {
    vi.useFakeTimers()

    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    // Initial load call
    const initialCallCount = mockApi.getSubscriptions.mock.calls.length
    expect(initialCallCount).toBeGreaterThanOrEqual(1)

    // Advance timer by 2000ms to trigger polling
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(mockApi.getSubscriptions.mock.calls.length).toBeGreaterThan(initialCallCount)
  })

  // Polling stops after timeout
  it('stops polling after 30 seconds', async () => {
    vi.useFakeTimers()

    const unsyncedSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([unsyncedSub]))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    // Advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(32000)
    await flushPromises()

    const callCountAfterTimeout = mockApi.getSubscriptions.mock.calls.length

    // Advance more time - should not call again
    await vi.advanceTimersByTimeAsync(4000)
    await flushPromises()

    expect(mockApi.getSubscriptions.mock.calls.length).toBe(callCountAfterTimeout)
  })

  // Count displays correctly with multiple subscriptions
  it('shows correct count with multiple subscriptions', async () => {
    const subs = [
      mockSubscription({ calendar_token: 'token-1' }),
      mockSubscription({ calendar_token: 'token-2', source_type: 'personal_courses' }),
      mockSubscription({ calendar_token: 'token-3', source_type: 'personal_exams' }),
    ]
    const { wrapper } = await mountDashboard(subs)

    expect(wrapper.text()).toContain('(3/5)')
  })

  // Source type labels render correctly for different types
  it('shows correct source type labels for different types', async () => {
    const subs = [
      mockSubscription({ calendar_token: 'token-1', source_type: 'personal_courses' }),
      mockSubscription({ calendar_token: 'token-2', source_type: 'personal_exams', is_personal: false }),
    ]
    const { wrapper } = await mountDashboard(subs)

    expect(wrapper.text()).toContain('课程')
    expect(wrapper.text()).toContain('考试')
  })

  // Error feedback: initial load failure
  it('shows toast error when initial load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  // Error feedback: refresh subscription failure
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

  // Error feedback: sync all failure
  it('shows toast error when sync all fails', async () => {
    const { wrapper } = await mountDashboard()
    mockApi.refreshSubscription.mockRejectedValue({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '同步超时' } } } },
    })

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('同步超时')
  })

  // Error feedback: delete subscription failure
  it('shows toast error when delete subscription fails', async () => {
    const exploreSub = mockSubscription({
      calendar_token: 'explore-1',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    mockApi.deleteSubscription.mockRejectedValue({
      response: { data: { detail: { error: { code: 'NOT_FOUND', message: '删除失败' } } } },
    })
    const { wrapper } = await mountDashboard([exploreSub])

    const deleteButtons = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    await deleteButtons[deleteButtons.length - 1].trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('删除失败')
  })

  // Sync all calls refreshSubscription in parallel
  it('sync all calls refreshSubscription in parallel (not sequentially)', async () => {
    vi.useFakeTimers()

    const subs = [
      mockSubscription({ calendar_token: 'p1', is_personal: true }),
      mockSubscription({ calendar_token: 'p2', is_personal: true, source_type: 'personal_courses' }),
    ]
    const { wrapper } = await mountDashboard(subs)

    // Set mock AFTER mountDashboard (which resets it via mockResolvedValue)
    const callOrder: string[] = []
    mockApi.refreshSubscription.mockImplementation(async (_token: string, subToken: string) => {
      callOrder.push(`start:${subToken}`)
      await new Promise(r => setTimeout(r, 50))
      callOrder.push(`end:${subToken}`)
      return {}
    })

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步个人课表'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    // Advance timers to resolve the setTimeout(50) inside the mock
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()

    // Both should start before either ends (parallel execution)
    expect(callOrder.indexOf('start:p2')).toBeLessThan(callOrder.indexOf('end:p1'))
  })

  // Error feedback: delete account failure
  it('shows toast error when delete account fails', async () => {
    mockApi.deleteUser.mockRejectedValue(new Error('server error'))
    const { wrapper } = await mountDashboard()

    // Type confirmation text
    const input = wrapper.find('input[placeholder="确认删除"]')
    await input.setValue('确认删除')

    // Find and click "删除账号" action button (the last one, inside AlertDialog)
    const actionButtons = wrapper.findAll('button').filter(b => b.text().includes('删除账号'))
    const deleteAccountAction = actionButtons[actionButtons.length - 1]
    await deleteAccountAction.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('删除账号失败')
  })
})
