import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import userEvent from '@testing-library/user-event'
import { AppProvider, type AppContextValue } from '@/providers/app'
import { captureScheduleEvent } from '@/lib/posthog'
import { mockMeResponse, mockSubscription, renderWithApp } from '@/test-utils'
import type { AppConfig, NotificationSettings, PersonalSetupSummary, Subscription, SubscriptionList } from '@/types/api'

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn(), info: vi.fn() }
  const mockApi = {
    getMe: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], count: 0 }),
    ensureDefaultSubscriptions: vi.fn(),
    getNotificationSettings: vi.fn().mockResolvedValue({ eligible: true, enabled: false }),
    updateNotificationSettings: vi.fn().mockResolvedValue({ eligible: true, enabled: true }),
    refreshSubscription: vi.fn(),
    refreshPersonalSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    createLink: vi.fn(),
    patchLink: vi.fn(),
    deleteLink: vi.fn(),
    rotateLink: vi.fn(),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi, redirect: { fn: vi.fn() } }))
vi.mock('@/lib/posthog', () => ({
  captureScheduleEvent: vi.fn(),
  syncPostHogIdentity: vi.fn(),
}))
vi.mock('@cqu-moe/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: mockToast,
}))
vi.mock('@/components/ShareLinksDialog', () => ({
  default: ({
    open,
    subscription,
  }: {
    open: boolean
    subscription: { source_name: string }
  }) => (open ? <div data-testid="share-links-dialog">{subscription.source_name}</div> : null),
}))

const { default: Dashboard } = await import('@/views/Dashboard')

function mockList(
  subs: Subscription[],
  setup: PersonalSetupSummary | null = null,
  manualRemaining: number | null = 5,
): SubscriptionList {
  return { subscriptions: subs, count: subs.length, personal_setup: setup, manual_remaining: manualRemaining }
}

function defaultLink(token = 'tok1') {
  return {
    id: 'link-default',
    token,
    label: null,
    formats: ['ics' as const, 'web' as const],
    is_default: true,
  }
}

const PERSONAL_SETUP: PersonalSetupSummary = {
  status: 'created',
  subscription_ids: ['all', 'courses', 'exams'],
  run_id: 'run-setup',
  dispatch_status: 'sent',
}

function firstSyncTrio(
  syncStatus: 'queued' | 'success' | 'error' = 'queued',
): Subscription[] {
  const base = {
    is_personal: true,
    sync_run_id: 'run-setup',
    last_synced_at: syncStatus === 'success' ? '2026-09-10T08:00:00Z' : null,
    sync_error_message: syncStatus === 'error' ? '同步服务暂时不可用' : null,
    links: [defaultLink()],
  }
  return [
    mockSubscription({
      id: 'all',
      source_type: 'personal_all',
      source_name: '我的全部课表',
      sync_status: syncStatus,
      ...base,
    }),
    mockSubscription({
      id: 'courses',
      source_type: 'personal_courses',
      source_name: '我的课程',
      sync_status: syncStatus,
      ...base,
    }),
    mockSubscription({
      id: 'exams',
      source_type: 'personal_exams',
      source_name: '我的考试',
      sync_status: syncStatus,
      ...base,
    }),
  ]
}

async function mountDashboard(
  subs: Subscription[] = [mockSubscription()],
  options: {
    session?: Partial<AppContextValue>
    setup?: PersonalSetupSummary | null
    route?: string
    manualRemaining?: number | null
  } = {},
) {
  mockApi.getSubscriptions.mockResolvedValue({ ...mockList(subs, options.setup ?? null), manual_remaining: 'manualRemaining' in options ? options.manualRemaining : 5 })
  const view = renderWithApp(<Dashboard />, {
    session: options.session,
    routerEntries: [options.route ?? '/dashboard'],
  })
  await waitFor(() => {
    expect(screen.queryByText('正在加载订阅')).not.toBeInTheDocument()
  })
  return view
}

describe('Dashboard view (v2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.getNotificationSettings.mockResolvedValue({ eligible: true, enabled: false })
    mockApi.updateNotificationSettings.mockResolvedValue({ eligible: true, enabled: true })
    mockApi.ensureDefaultSubscriptions.mockResolvedValue({
      status: 'created',
      subscription_ids: ['all', 'courses', 'exams'],
      run_id: 'run-setup',
      dispatch_status: 'sent',
    })
    mockApi.refreshPersonalSubscription.mockResolvedValue({
      status: 'queued',
      run_id: 'run-1',
      affected_subscription_ids: ['sub-1'],
      cooldown_until: '',
    })
    mockApi.refreshSubscription.mockResolvedValue({
      status: 'queued',
      run_id: 'run-1',
      affected_subscription_ids: [],
      cooldown_until: '',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers teaching-class reselection for expired and failed targets, never pending or active targets', async () => {
    mockApi.getSubscriptions.mockResolvedValue(mockList([
      ...(['expired', 'failed', 'pending', 'active', 'legacy'] as const).map(id => mockSubscription({
        id, source_name: id, source_type: 'course', source_version: id === 'legacy' ? 0 : 1, is_personal: false,
        external_state: id === 'failed' || id === 'pending' ? 'reselecting' : id === 'active' ? 'active' : 'expired',
        sync_status: id === 'failed' ? 'error' : id === 'pending' ? 'queued' : 'idle',
        sync_error_message: id === 'failed' ? '采集失败' : null,
        import_quality: id === 'pending' ? 'empty' : undefined,
        last_synced_at: id === 'pending' || id === 'failed' ? '2025-09-01T00:00:00Z' : null,
      })),
    ]))
    renderWithApp(<Dashboard />, { session: { quota: () => 0 } })
    expect(await screen.findByRole('link', { name: '重新选择教学班：expired' })).toHaveAttribute('href', '/add?reselect=expired')
    expect(screen.getByRole('link', { name: '重新选择教学班：failed' })).toHaveAttribute('href', '/add?reselect=failed')
    expect(screen.getAllByRole('link', { name: /重新选择教学班：/ })).toHaveLength(2)
    expect(screen.queryByText('当前学期暂无课表安排')).not.toBeInTheDocument()
    expect(screen.queryByText(/同步于|上次成功/)).not.toBeInTheDocument()
  })

  it.each(['personal', 'legacy'])('keeps the add entry available when only %s subscriptions exist at a one-slot external quota', async kind => {
    const sub = mockSubscription({
      id: kind, source_type: kind === 'personal' ? 'personal_all' : 'instructor',
      is_personal: kind === 'personal', source_version: 0,
    })
    await mountDashboard([sub], { session: { quota: key => key === 'sub_limit' ? 1 : null } })
    expect(screen.getByRole('link', { name: '添加订阅' })).toHaveAttribute('href', '/add')
    expect(screen.queryByText('已达外部订阅上限')).not.toBeInTheDocument()
    expect(screen.getByText('1 个订阅')).toBeInTheDocument()
    expect(screen.getByText('外部订阅额度 0 / 1')).toBeInTheDocument()
  })

  it('disables the add entry when a genuine new external subscription uses the last slot', async () => {
    await mountDashboard([
      mockSubscription({ id: 'personal', is_personal: true, source_version: 0 }),
      mockSubscription({ id: 'legacy', source_type: 'instructor', is_personal: false, source_version: 0 }),
      mockSubscription({ id: 'new', source_type: 'course', is_personal: false, source_version: 1, external_state: 'expired' }),
    ], { session: { quota: key => key === 'sub_limit' ? 1 : null } })
    expect(screen.getByRole('button', { name: '添加订阅' })).toBeDisabled()
    expect(screen.getByText('3 个订阅')).toBeInTheDocument()
    expect(screen.getByText('外部订阅额度 1 / 1')).toBeInTheDocument()
    expect(screen.getByText('已达外部订阅上限')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '添加订阅' })).not.toBeInTheDocument()
  })

  it('renders the subscription list with count, badges and sync date', async () => {
    const quota = vi.fn((key: string) => (key === 'sub_limit' ? 5 : null))
    await mountDashboard(
      [
        mockSubscription({
          source_name: '张三的课表',
          session_name: '2025秋',
          last_synced_at: '2026-03-01T10:00:00Z',
          links: [defaultLink()],
        }),
        mockSubscription({
          id: 'ext-1',
          source_type: 'instructor',
          source_name: '李四老师',
          session_name: null,
          is_personal: false,
          links: [],
        }),
      ],
      { session: { quota: quota as unknown as AppContextValue['quota'] } },
    )

    expect(screen.getByRole('heading', { name: '我的订阅' })).toBeInTheDocument()
    expect(screen.getByText('2 个订阅')).toBeInTheDocument()
    expect(screen.getByText('外部订阅额度 0 / 5')).toBeInTheDocument()
    expect(screen.getByText('自动同步已开启')).toBeInTheDocument()
    expect(screen.getByText('张三的课表')).toBeInTheDocument()
    expect(screen.getByText('李四老师')).toBeInTheDocument()
    expect(screen.getByText('全部')).toBeInTheDocument()
    expect(screen.getByText('2025秋')).toBeInTheDocument()
    expect(screen.getByText('教师')).toBeInTheDocument()
    expect(screen.getByText(/同步于/)).toBeInTheDocument()
    expect(screen.getByText('尚未同步')).toBeInTheDocument()
  })

  it('shows the empty state with a next step when no subscriptions', async () => {
    await mountDashboard([])
    expect(screen.getByText('还没有订阅')).toBeInTheDocument()
    expect(
      screen.getByText('添加课表订阅后，课表会自动同步到你的日历应用。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '添加新订阅' })).toBeInTheDocument()
  })

  it('shows personal and external entitlement states separately without treating absent rights as failures', async () => {
    await mountDashboard([mockSubscription()], {
      session: {
        caps: {
          ...mockMeResponse().caps.calendar,
          external_sync_interval: undefined,
          external_manual_refresh: undefined,
        },
      },
    })
    expect(screen.getByText('自动同步已开启')).toBeInTheDocument()
    expect(screen.getByText('外部订阅已开通')).toBeInTheDocument()
    expect(screen.getByText('外部自动同步未授予')).toBeInTheDocument()
    expect(screen.getAllByText('外部手动刷新未授予').length).toBeGreaterThan(0)

    cleanup()
    await mountDashboard([mockSubscription()], {
      session: {
        caps: {
          ...mockMeResponse().caps.calendar,
          external_sync_interval: 0,
          external_manual_refresh: null,
        },
      },
      manualRemaining: null,
    })
    expect(screen.getByText('外部自动同步已关闭')).toBeInTheDocument()
    expect(screen.getAllByText('外部手动刷新剩余无限').length).toBeGreaterThan(0)

    cleanup()
    await mountDashboard([mockSubscription()], {
      session: {
        caps: {
          ...mockMeResponse().caps.calendar,
          external_sync_interval: 30,
          external_manual_refresh: 7,
        },
      },
      manualRemaining: 7,
    })
    expect(screen.getByText('外部自动同步每 30 分钟')).toBeInTheDocument()
    expect(screen.getAllByText('外部手动刷新剩余 7 次').length).toBeGreaterThan(0)

    cleanup()
    await mountDashboard([mockSubscription()], {
      session: {
        caps: {
          ...mockMeResponse().caps.calendar,
          external: false,
        },
      },
    })
    expect(screen.getByText('外部自动同步需先开通外部订阅')).toBeInTheDocument()
    expect(screen.getByText('外部手动刷新需先开通外部订阅')).toBeInTheDocument()
  })

  it('shows an error state with retry when the list fails to load', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))
    renderWithApp(<Dashboard />)
    await screen.findByText('暂时无法加载订阅')
    expect(screen.getByText('订阅状态暂不可用')).toBeInTheDocument()
    expect(screen.queryByText(/外部订阅额度/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()

    mockApi.getSubscriptions.mockResolvedValue(mockList([mockSubscription()]))
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByText('我的课表')).toBeInTheDocument()
  })

  it('shows a binding card when auth reports the user is unbound', async () => {
    await mountDashboard([], { session: { isCquUnbound: true } })
    expect(screen.getByText('尚未绑定重庆大学统一认证账号')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: '绑定重庆大学统一认证账号' })
    expect(link.getAttribute('href')).toContain('auth.cqu.moe/cqu/bind?')
  })

  it('copies the ICS URL to clipboard with feedback', async () => {
    await mountDashboard([mockSubscription({ links: [defaultLink('tok-abc')] })])
    const copyButton = screen.getByRole('button', { name: '复制链接' })
    await userEvent.click(copyButton)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/api/v2/calendar/tok-abc/calendar.ics',
    )
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
    expect(captureScheduleEvent).toHaveBeenCalledWith('schedule_action_finished', {
      actor_type: 'user',
      trigger: 'user',
      operation: 'copy_calendar_link',
      outcome: 'success',
      format: 'ics',
    })
  })

  it('keeps new external links unavailable before first successful capture', async () => {
    await mountDashboard([mockSubscription({ source_type: 'admin_class', source_version: 1, is_personal: false,
      source_name: '首次行政班', last_synced_at: null, sync_status: 'error', sync_error_message: '学校暂时不可用', links: [defaultLink()] })])
    expect(screen.getByRole('button', { name: '查看课表：首次行政班' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制链接' })).toBeDisabled()
    expect(screen.getByText('同步失败：学校暂时不可用')).toBeInTheDocument()
  })

  it('shows retained external snapshot time alongside a refresh failure', async () => {
    await mountDashboard([mockSubscription({ source_type: 'admin_class', source_version: 1, is_personal: false,
      source_name: '保留课表行政班', external_state: 'active', last_synced_at: '2026-03-01T10:00:00Z',
      sync_status: 'error', sync_error_message: '学校暂时不可用', links: [defaultLink()] })])
    expect(screen.getByText('同步失败：学校暂时不可用')).toBeInTheDocument()
    expect(screen.getByText('上次成功：2026/03/01 18:00')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看课表：保留课表行政班' })).toHaveAttribute('href', expect.stringContaining('/view/'))
  })

  it('reports a failed calendar-link copy without exposing its URL', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    await mountDashboard([mockSubscription({ links: [defaultLink('tok-abc')] })])
    await userEvent.click(screen.getByRole('button', { name: '复制链接' }))

    expect(await screen.findByRole('button', { name: '复制失败' })).toBeInTheDocument()
    const call = vi.mocked(captureScheduleEvent).mock.calls.at(-1)
    expect(call?.[0]).toBe('schedule_action_finished')
    expect(call?.[1]).toMatchObject({
      actor_type: 'user',
      trigger: 'user',
      operation: 'copy_calendar_link',
      outcome: 'failure',
      format: 'ics',
    })
    expect(JSON.stringify(call?.[1])).not.toContain('tok-abc')
  })

  it('runs the manual refresh state flow: queue → syncing → complete', async () => {
    const sub = mockSubscription({
      last_synced_at: '2026-03-01T10:00:00Z',
      links: [defaultLink()],
    })
    await mountDashboard([sub])

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '同步' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockApi.refreshPersonalSubscription).toHaveBeenCalledTimes(1)
    expect(mockApi.refreshSubscription).not.toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('已加入刷新队列')
    expect(screen.getByRole('button', { name: '同步中' })).toBeInTheDocument()

    mockApi.getSubscriptions.mockResolvedValue(
      mockList([
        {
          ...sub,
          sync_status: 'success',
          sync_run_id: 'run-1',
          last_synced_at: '2026-03-01T11:00:00Z',
        },
      ]),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(mockToast.success).toHaveBeenCalledWith('同步完成')
    expect(screen.queryByRole('button', { name: '同步中' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /分钟后可同步/ })).toHaveLength(2)
  })

  it('keeps the by-id endpoint for an external card sync button', async () => {
    mockApi.refreshSubscription.mockResolvedValue({
      status: 'queued',
      run_id: 'run-2',
      affected_subscription_ids: ['ext-1'],
      cooldown_until: '',
    })
    await mountDashboard([
      mockSubscription({
        id: 'ext-1',
        source_type: 'instructor',
        source_version: 1,
        external_state: 'active',
        is_active: true,
        is_personal: false,
        last_synced_at: '2026-03-01T10:00:00Z',
      }),
    ])
    fireEvent.click(screen.getByRole('button', { name: '同步' }))
    await waitFor(() => {
      expect(mockApi.refreshSubscription).toHaveBeenCalledWith('ext-1')
      expect(mockApi.refreshPersonalSubscription).not.toHaveBeenCalled()
    })
  })

  it('uses the list-owned external manual quota while keeping personal refresh independent', async () => {
    const personal = mockSubscription({
      id: 'personal-1',
      last_synced_at: '2026-03-01T10:00:00Z',
      links: [defaultLink()],
    })
    const external = mockSubscription({
      id: 'ext-quota',
      source_type: 'admin_class',
      source_version: 1,
      external_state: 'active',
      is_active: true,
      is_personal: false,
      last_synced_at: '2026-03-01T10:00:00Z',
      links: [defaultLink('ext-tok')],
    })
    mockApi.getSubscriptions.mockResolvedValue(mockList([personal, external], null, 0))
    renderWithApp(<Dashboard />)
    await screen.findAllByText('我的课表')

    expect(screen.getByText('外部手动刷新剩余 0 次')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '今日额度已用完' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '同步' }))
    await waitFor(() => expect(mockApi.refreshPersonalSubscription).toHaveBeenCalledOnce())
    expect(mockApi.refreshSubscription).not.toHaveBeenCalled()

    cleanup()
    mockApi.refreshSubscription.mockResolvedValue({
      status: 'queued',
      run_id: 'run-unlimited',
      affected_subscription_ids: ['ext-quota'],
      cooldown_until: '',
      manual_remaining: null,
    })
    mockApi.getSubscriptions.mockResolvedValue(mockList([external], null, null))
    renderWithApp(<Dashboard />)
    const unlimitedButton = await screen.findByRole('button', { name: '同步' })
    expect(screen.getAllByText('外部手动刷新剩余无限').length).toBeGreaterThan(0)
    expect(unlimitedButton).toBeEnabled()
    unlimitedButton.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(mockApi.refreshSubscription).toHaveBeenCalledWith('ext-quota'))
  })

  it('keeps external refresh admission dependent on current rights, lifecycle, and known remaining quota', async () => {
    const external = mockSubscription({
      id: 'ext-admission',
      source_type: 'admin_class',
      source_version: 1,
      external_state: 'active',
      is_active: true,
      is_personal: false,
      last_synced_at: '2026-03-01T10:00:00Z',
    })
    const baseCaps = mockMeResponse().caps.calendar
    const cases = [
      {
        label: '外部订阅未开通',
        sub: external,
        caps: { ...baseCaps, external: false },
        remaining: 5,
      },
      {
        label: '外部手动刷新未授予',
        sub: external,
        caps: { ...baseCaps, external_manual_refresh: undefined },
        remaining: 5,
      },
      {
        label: '外部手动刷新已关闭',
        sub: external,
        caps: { ...baseCaps, external_manual_refresh: 0 },
        remaining: 0,
      },
      {
        label: '外部手动刷新剩余未知',
        sub: external,
        caps: baseCaps,
        remaining: undefined,
      },
      {
        label: '暂不可用',
        sub: { ...external, external_state: 'expired' as const },
        caps: baseCaps,
        remaining: 5,
      },
      {
        label: '暂不可用',
        sub: { ...external, is_active: false },
        caps: baseCaps,
        remaining: 5,
      },
    ]

    for (const item of cases) {
      mockApi.getSubscriptions.mockResolvedValue({
        ...mockList([item.sub], null, item.remaining ?? 5),
        manual_remaining: item.remaining,
      })
      await mountDashboard([item.sub], {
        session: { caps: item.caps, can: key => item.caps[key] === true },
        manualRemaining: item.remaining,
      })
      expect(screen.getByRole('button', { name: item.label })).toBeDisabled()
      expect(mockApi.refreshSubscription).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it.each(['expired', 'reselecting'] as const)('keeps every download unavailable for a %s teaching class', async (external_state) => {
    await mountDashboard([mockSubscription({ source_type: 'course', source_version: 1, is_personal: false,
      external_state, sync_status: external_state === 'reselecting' ? 'queued' : 'idle', links: [defaultLink()] })])
    await userEvent.click(screen.getByRole('button', { name: /的更多操作$/ }))
    const menu = await screen.findByRole('menu')
    for (const item of within(menu).getAllByRole('menuitem', { name: /^下载 / })) {
      expect(item).toHaveAttribute('aria-disabled', 'true')
      expect(item).not.toHaveAttribute('href')
      expect(item.querySelector('a')).toBeNull()
    }
    expect(within(menu).getByRole('menuitem', { name: '管理共享链接' })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/全部公共链接暂时停用/)).toBeInTheDocument()
  })

  it('opens the share links dialog from the more menu', async () => {
    await mountDashboard([mockSubscription({ links: [defaultLink()] })])
    await userEvent.click(screen.getByRole('button', { name: /的更多操作$/ }))
    const menu = await screen.findByRole('menu')
    await userEvent.click(within(menu).getByText('管理共享链接'))
    expect(await screen.findByTestId('share-links-dialog')).toHaveTextContent('我的课表')
  })

  describe('approved first-sync feedback', () => {
    it('shows one syncing notice and disables link operations until data exists', async () => {
      await mountDashboard(firstSyncTrio('queued'), {
        setup: PERSONAL_SETUP,
        route: '/dashboard?setup=1',
      })

      expect(mockApi.ensureDefaultSubscriptions).toHaveBeenCalledTimes(1)
      expect(document.querySelectorAll('.sync-notice')).toHaveLength(1)
      expect(screen.getByText('正在同步课表')).toBeInTheDocument()
      expect(screen.getByText('3 个订阅')).toBeInTheDocument()
      expect(screen.getByText('我的全部课表')).toBeInTheDocument()

      const copyButtons = screen.getAllByRole('button', { name: '复制链接' })
      expect(copyButtons).toHaveLength(3)
      for (const button of copyButtons) expect(button).toBeDisabled()
      for (const button of screen.getAllByRole('button', { name: /二维码$/ })) {
        expect(button).toBeDisabled()
      }
      for (const button of screen.getAllByRole('button', { name: /的更多操作$/ })) {
        expect(button).toBeEnabled()
      }
    })

    it('shows success for this visit, enables operations, and dismisses the notice', async () => {
      await mountDashboard(firstSyncTrio('success'), {
        setup: PERSONAL_SETUP,
        route: '/dashboard?setup=1',
      })

      expect(screen.getByText('课表已同步')).toBeInTheDocument()
      expect(screen.getAllByText('刚刚同步')).toHaveLength(3)
      for (const button of screen.getAllByRole('button', { name: '复制链接' })) {
        expect(button).toBeEnabled()
      }

      fireEvent.click(screen.getByRole('button', { name: '关闭同步提示' }))
      expect(screen.queryByText('课表已同步')).not.toBeInTheDocument()
      expect(screen.getByText('我的全部课表')).toBeInTheDocument()
      expect(mockApi.deleteSubscription).not.toHaveBeenCalled()
      expect(mockApi.refreshSubscription).not.toHaveBeenCalled()
    })

    it('does not repeat the completed notice on an ordinary later visit', async () => {
      await mountDashboard(firstSyncTrio('success'), { setup: PERSONAL_SETUP })
      expect(screen.queryByText('课表已同步')).not.toBeInTheDocument()
      expect(mockApi.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    })

    it('retries a finished sync error through the personal group refresh once', async () => {
      const subs = firstSyncTrio('success')
      subs[1] = {
        ...subs[1],
        sync_status: 'error',
        last_synced_at: null,
        sync_error_message: '同步服务暂时不可用',
      }
      await mountDashboard(subs, { setup: PERSONAL_SETUP })

      expect(screen.getByText('暂时无法同步')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await waitFor(() => {
        expect(mockApi.refreshPersonalSubscription).toHaveBeenCalledTimes(1)
      })
      expect(mockApi.refreshSubscription).not.toHaveBeenCalled()
      expect(mockApi.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    })
  })

  it('shows and toggles the change notification switch for eligible users', async () => {
    await mountDashboard()
    const toggle = screen.getByRole('switch', { name: '课表变更通知' })
    expect(mockApi.getNotificationSettings).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(toggle).not.toBeDisabled())

    await userEvent.click(toggle)
    await waitFor(() => {
      expect(mockApi.updateNotificationSettings).toHaveBeenCalledWith(true)
    })
    expect(screen.getByRole('switch', { name: '课表变更通知' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it.each(['config', 'session'])('finishes notification loading across a %s update', async (update) => {
    let resolveConfig!: (config: AppConfig) => void
    let resolveSettings!: (settings: NotificationSettings) => void
    mockApi.getMe.mockResolvedValue(mockMeResponse())
    mockApi.getConfig.mockReturnValue(new Promise<AppConfig>((resolve) => { resolveConfig = resolve }))
    mockApi.getNotificationSettings.mockReturnValue(
      new Promise<NotificationSettings>((resolve) => { resolveSettings = resolve }),
    )
    render(
      <StrictMode>
        <AppProvider>
          <MemoryRouter initialEntries={['/dashboard']}><Dashboard /></MemoryRouter>
        </AppProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(mockApi.getNotificationSettings).toHaveBeenCalled())
    await act(async () => {
      if (update === 'config') resolveConfig({ public_url: 'https://schedule.cqu.moe' })
      else fireEvent.focus(window)
    })
    await act(async () => resolveSettings({ eligible: true, enabled: true }))
    const toggle = screen.getByRole('switch', { name: '课表变更通知' })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })
})
