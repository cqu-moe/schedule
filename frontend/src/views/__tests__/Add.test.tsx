import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Add, { externalSubscriptions } from '@/views/Add'
import { mockSubscription, renderWithApp } from '@/test-utils'
import type { DefaultSubscriptionsResponse } from '@/types/api'

const { mockApi, mockRedirect, mockToast } = vi.hoisted(() => ({
  mockApi: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn(),
    ensureDefaultSubscriptions: vi.fn(),
    createSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    searchExternal: vi.fn(),
    getDepartments: vi.fn(),
    getViewData: vi.fn(),
  },
  mockRedirect: { fn: vi.fn() },
  mockToast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/api', () => ({ default: mockApi, redirect: mockRedirect }))
// sonner 不是本项目直接依赖，无法直接 mock；对 @cqu-moe/ui 做部分 mock 只替换 toast。
vi.mock('@cqu-moe/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: mockToast,
}))

async function enableExternal() {
  externalSubscriptions.enabled = true
}

describe('Add view (React)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    externalSubscriptions.enabled = false
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.getDepartments.mockResolvedValue({ departments: [] })
  })

  afterEach(() => {
    externalSubscriptions.enabled = false
  })

  it('renders personal subscription options', async () => {
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    expect(await screen.findByText('我的全部课表')).toBeInTheDocument()
    expect(screen.getByText('我的课程')).toBeInTheDocument()
    expect(screen.getByText('我的考试')).toBeInTheDocument()
  })

  it('shows guidance instead of personal options when sync is unavailable', async () => {
    renderWithApp(<Add />, { routerEntries: ['/add'], session: { can: () => false } })
    expect(await screen.findByText(/个人课表订阅需要开通/)).toBeInTheDocument()
    expect(screen.queryByText('我的全部课表')).not.toBeInTheDocument()
  })

  it('shows the binding prompt when the account is known-unbound', async () => {
    renderWithApp(
      <Add />,
      {
        routerEntries: ['/add'],
        session: { cquBindStatus: 'unbound', isCquUnbound: true },
      },
    )
    const link = await screen.findByRole('link', { name: '绑定重庆大学统一认证账号' })
    expect(screen.getByText(/尚未绑定重庆大学统一认证账号/)).toBeInTheDocument()
    expect(link.getAttribute('href')).toContain('auth.cqu.moe/cqu/bind')
    expect(screen.queryByText('我的全部课表')).not.toBeInTheDocument()
  })

  it('shows cleanup progress without a bind or subscription action while deleting', async () => {
    renderWithApp(<Add />, { routerEntries: ['/add'], session: { cquBindStatus: 'deleting', isCquBound: false, isCquUnbound: true } })
    expect(await screen.findByRole('link', { name: '认证中心查看解绑进度' })).toHaveAttribute('href', 'https://auth.cqu.moe/settings/cqu')
    expect(screen.queryByRole('link', { name: '绑定重庆大学统一认证账号' })).not.toBeInTheDocument()
    expect(screen.queryByText('我的全部课表')).not.toBeInTheDocument()
  })

  it('creates a personal subscription without sourceId and toasts success', async () => {
    mockApi.createSubscription.mockResolvedValue({ id: 'p-new' })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.click(await screen.findByRole('button', { name: '订阅我的全部课表' }))
    await waitFor(() =>
      expect(mockApi.createSubscription).toHaveBeenCalledWith({
        sourceType: 'personal_all',
        sourceName: '我的全部课表',
        isPersonal: true,
      }),
    )
    expect(mockApi.createSubscription.mock.calls[0][0]).not.toHaveProperty('sourceId')
    expect(mockToast.success).toHaveBeenCalledWith('已订阅「我的全部课表」')
    await waitFor(() => expect(mockApi.getSubscriptions).toHaveBeenCalledWith(true))
  })

  it('disables subscribe buttons and explains the limit when at sub_limit', async () => {
    const fiveSubs = Array.from({ length: 5 }, (_, i) =>
      mockSubscription({ id: `sub-${i}`, source_type: 'course', source_id: `c${i}`, is_personal: false }),
    )
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: fiveSubs, count: 5 })
    renderWithApp(
      <Add />,
      {
        routerEntries: ['/add'],
        session: { quota: (key) => (key === 'sub_limit' ? 5 : null) },
      },
    )
    const button = await screen.findByRole('button', { name: '订阅我的全部课表' })
    expect(button).toBeDisabled()
    expect(await screen.findByText('已达订阅上限，请先删除不需要的订阅')).toBeInTheDocument()
  })

  it('soft-disables the external section by default', async () => {
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    expect(await screen.findByText('暂不可用')).toBeInTheDocument()
    expect(
      screen.getByText('外部订阅（教师、教室、课程、行政班等）功能暂不可用。'),
    ).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/输入/)).not.toBeInTheDocument()
    expect(mockApi.searchExternal).not.toHaveBeenCalled()
  })

  it('switches source type tabs and loads departments for admin_class', async () => {
    await enableExternal()
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.click(await screen.findByRole('tab', { name: '行政班' }))
    await waitFor(() => expect(mockApi.getDepartments).toHaveBeenCalled())
    expect(screen.getByPlaceholderText('输入班级名称关键词（可选）')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '教师' }))
    expect(screen.getByPlaceholderText('输入教师姓名或工号')).toBeInTheDocument()
  })

  it('searches, renders results and creates an external subscription with sourceId', async () => {
    await enableExternal()
    mockApi.searchExternal.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '张三', extra: '计算机学院' }],
    })
    mockApi.createSubscription.mockResolvedValue({ id: 'ext-new' })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    const input = await screen.findByPlaceholderText('输入教师姓名或工号')
    await user.type(input, '张三')
    await waitFor(() =>
      expect(mockApi.searchExternal).toHaveBeenCalledWith(
        expect.objectContaining({ source_type: 'instructor', keyword: '张三' }),
      ),
    )
    expect(await screen.findByText('计算机学院')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '订阅张三' }))
    await waitFor(() =>
      expect(mockApi.createSubscription).toHaveBeenCalledWith({
        sourceType: 'instructor',
        sourceId: 'teacher-1',
        sourceName: '张三',
      }),
    )
    expect(mockToast.success).toHaveBeenCalledWith('已订阅「张三」')
  })

  it('does not search for keywords shorter than two characters', async () => {
    await enableExternal()
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    const input = await screen.findByPlaceholderText('输入教师姓名或工号')
    await user.type(input, '张')
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(mockApi.searchExternal).not.toHaveBeenCalled()
  })

  it('marks already-subscribed external results as subscribed', async () => {
    await enableExternal()
    mockApi.getSubscriptions.mockResolvedValue({
      subscriptions: [
        mockSubscription({ source_type: 'instructor', source_id: 'teacher-1', is_personal: false }),
      ],
      count: 1,
    })
    mockApi.searchExternal.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '张三', extra: '' }],
    })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByPlaceholderText('输入教师姓名或工号'), '张三')
    const subscribed = await screen.findByRole('button', { name: '已订阅张三' })
    expect(subscribed).toBeDisabled()
  })

  it('shows an inline error when the search fails', async () => {
    await enableExternal()
    mockApi.searchExternal.mockRejectedValue({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '搜索失败' } } } },
    })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByPlaceholderText('输入教师姓名或工号'), '张三')
    expect(await screen.findByText('搜索失败')).toBeInTheDocument()
  })

  it('shows the setup error with a working retry after ?setup=1 fails', async () => {
    mockApi.getSubscriptions.mockResolvedValue({
      subscriptions: [mockSubscription()], count: 1,
    })
    mockApi.ensureDefaultSubscriptions
      .mockRejectedValueOnce({
        response: { data: { detail: { error: { code: 'X', message: '准备失败' } } } },
      })
      .mockResolvedValueOnce({
        status: 'existing',
        subscription_ids: [],
        run_id: null,
        dispatch_status: 'none',
      })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add?setup=1'] })
    expect(await screen.findByText('准备失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mockApi.ensureDefaultSubscriptions).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: '已订阅' })).toBeDisabled()
  })

  it('loads existing subscriptions and quota after setup stays on Add', async () => {
    let resolveSetup!: (result: DefaultSubscriptionsResponse) => void
    mockApi.ensureDefaultSubscriptions.mockReturnValueOnce(
      new Promise<DefaultSubscriptionsResponse>((resolve) => { resolveSetup = resolve }),
    )
    mockApi.getSubscriptions.mockResolvedValue({
      subscriptions: [mockSubscription()], count: 1,
    })
    renderWithApp(<Add />, {
      routerEntries: ['/add?setup=1'],
      session: { quota: (key) => key === 'sub_limit' ? 1 : null },
    })
    await waitFor(() => expect(mockApi.ensureDefaultSubscriptions).toHaveBeenCalled())
    await act(async () => resolveSetup({
      status: 'existing', subscription_ids: ['sub-1'], run_id: null, dispatch_status: 'none',
    }))
    expect(await screen.findByRole('button', { name: '已订阅' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '订阅我的课程' })).toBeDisabled()
    expect(screen.getByText('已达订阅上限，请先删除不需要的订阅')).toBeInTheDocument()
  })

  it('toasts when the initial subscription list fails to load', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败'))
  })
})
