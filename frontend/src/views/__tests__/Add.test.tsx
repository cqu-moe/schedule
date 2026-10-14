import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Add from '@/views/Add'
import { AppProvider } from '@/providers/app'
import { MemoryRouter, useLocation } from 'react-router'
import { mockMeResponse, mockSubscription, renderWithApp } from '@/test-utils'
import type { DefaultSubscriptionsResponse } from '@/types/api'

const { mockApi, mockRedirect, mockToast } = vi.hoisted(() => ({
  mockApi: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn(),
    ensureDefaultSubscriptions: vi.fn(),
    createSubscription: vi.fn(),
    reselectTeachingClass: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    searchExternal: vi.fn(),
    searchTeachingClasses: vi.fn(),
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

function ReselectionLocation() {
  const location = useLocation()
  return location.pathname === '/dashboard' ? <p role="status">重新同步 {location.state?.reselection?.id} {location.state?.reselection?.runId}</p> : null
}

async function enableExternal() {
  const sources = ['instructor', 'room', 'laboratory', 'course', 'admin_class']
  mockApi.getMe.mockResolvedValue({ public_url: '', external: { search_types: sources, create_types: sources } })
}

describe('Add view (React)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getMe.mockResolvedValue({ public_url: '', external: { search_types: [], create_types: [] } })
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.getDepartments.mockResolvedValue({ departments: [] })
  })

  it('submits a search with Enter from the input without repeating the debounce request', async () => {
    await enableExternal()
    mockApi.searchExternal.mockResolvedValue({ session: { id: 'term', name: '当前学期' }, selection_token: 'receipt',
      results: [{ id: 'teacher', name: '测试教师' }] })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    const input = await screen.findByRole('searchbox', { name: '搜索教师' })
    await user.type(input, '测试{Enter}')
    expect(mockApi.searchExternal).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('测试教师')).toBeInTheDocument()
    expect(input).toHaveFocus()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(mockApi.searchExternal).toHaveBeenCalledTimes(1)
    expect(mockApi.searchExternal).toHaveBeenCalledWith(expect.objectContaining({ source_type: 'instructor', keyword: '测试' }))
    const selectedTab = screen.getByRole('tab', { name: '教师' })
    expect(screen.getByRole('tabpanel', { name: '教师' })).toHaveAttribute('id', selectedTab.getAttribute('aria-controls'))
  })

  it('uses server availability and shows the current term and truncated results', async () => {
    mockApi.getMe.mockResolvedValue({ public_url: '', external: { search_types: ['admin_class'], create_types: [] } })
    mockApi.searchExternal.mockResolvedValue({
      session: { id: 'term-26', name: '2026秋' }, truncated: true,
      results: [{ id: 'class-1', name: '电气测试班', extra: '2026级' }],
    })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByRole('searchbox', { name: '搜索班级' }), '电气')
    expect(await screen.findByText('当前学期：2026秋')).toBeInTheDocument()
    expect(screen.getByText('结果可能不完整，请缩小搜索范围。')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '教师' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '订阅电气测试班' })).toBeDisabled()
    expect(mockApi.createSubscription).not.toHaveBeenCalled()
  })

  it('selects a course before selecting and subscribing to its teaching class', async () => {
    mockApi.getMe.mockResolvedValue({ external: { search_types: ['course'], create_types: ['course'] } })
    mockApi.searchExternal.mockResolvedValue({ stage: 'courses', session: { id: 'current', name: '当前学期' }, selection_token: 'catalog-token', truncated: false,
      results: [{ id: 'catalog-1', name: '大学物理', extra: 'PHYS1001' }] })
    mockApi.searchTeachingClasses.mockResolvedValue({ stage: 'classes', course: { id: 'catalog-1', name: '大学物理' }, session: { id: 'current', name: '当前学期' }, selection_token: 'class-token', truncated: false,
      results: [{ id: 'class-1', name: '大学物理 01班', extra: '教师甲' }, { id: 'class-2', name: '大学物理 02班', extra: '教师乙' }] })
    mockApi.createSubscription.mockResolvedValue({ id: 'new-course' })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByRole('searchbox', { name: '搜索课程' }), '物理')
    const select = await screen.findByRole('button', { name: '选择课程大学物理' })
    select.focus(); await user.keyboard('{Enter}')
    expect(mockApi.createSubscription).not.toHaveBeenCalled()
    expect(mockApi.searchTeachingClasses).toHaveBeenCalledWith('catalog-1', 'catalog-token')
    await waitFor(() => expect(screen.getByRole('button', { name: '订阅大学物理 01班' })).toHaveFocus())
    await user.click(await screen.findByRole('button', { name: '订阅大学物理 02班' }))
    expect(mockApi.createSubscription).toHaveBeenCalledWith({ sourceType: 'course', sourceId: 'class-2', sourceName: '大学物理 02班', selectionToken: 'class-token', sessionId: 'current' })
    await user.click(screen.getByRole('button', { name: '重新选择课程' }))
    expect(screen.queryByRole('button', { name: '订阅大学物理 02班' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('searchbox', { name: '搜索课程' })).toHaveFocus())
  })

  it('retains keyboard focus through teaching-class loading, failure, retry and success', async () => {
    mockApi.getMe.mockResolvedValue({ external: { search_types: ['course'], create_types: ['course'] } })
    mockApi.searchExternal.mockResolvedValue({ session: { id: 'term', name: '当前学期' }, selection_token: 'catalog',
      results: [{ id: 'course', name: '大学物理' }] })
    let rejectLookup!: (error: unknown) => void
    let resolveRetry!: (result: unknown) => void
    mockApi.searchTeachingClasses
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLookup = reject }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve }))
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByRole('searchbox', { name: '搜索课程' }), '物理')
    const course = await screen.findByRole('button', { name: '选择课程大学物理' })
    course.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('大学物理 · 选择教学班')).toHaveFocus()
    expect(screen.queryByRole('button', { name: '选择课程大学物理' })).not.toBeInTheDocument()
    await act(async () => rejectLookup(new Error('offline')))
    const retry = await screen.findByRole('button', { name: '重试搜索' })
    expect(retry).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('大学物理 · 选择教学班')).toHaveFocus()
    await act(async () => resolveRetry({ session: { id: 'term', name: '当前学期' }, selection_token: 'receipt',
      results: [{ id: 'class', name: '物理01班' }] }))
    expect(await screen.findByRole('button', { name: '订阅物理01班' })).toHaveFocus()
    expect(mockApi.searchTeachingClasses).toHaveBeenNthCalledWith(2, 'course', 'catalog')
    expect(mockApi.createSubscription).not.toHaveBeenCalled()
  })

  it('reselects on the original subscription at full quota with external permission only', async () => {
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [mockSubscription({
      id: 'original', source_type: 'course', source_version: 1, is_personal: false,
      external_state: 'expired',
    })], count: 1 })
    mockApi.getMe.mockResolvedValue({ external: { search_types: ['instructor', 'course'], create_types: [] } })
    mockApi.searchExternal.mockResolvedValue({ selection_token: 'catalog', session: { id: 'term', name: '当前学期' }, results: [{ id: 'course', name: '物理' }] })
    mockApi.searchTeachingClasses.mockResolvedValue({ selection_token: 'receipt', session: { id: 'term', name: '当前学期' }, results: [{ id: 'class', name: '物理01班' }] })
    mockApi.reselectTeachingClass.mockResolvedValue({ status: 'queued', run_id: 'run', reused: false })
    const user = userEvent.setup()
    renderWithApp(<><Add /><ReselectionLocation /></>, { routerEntries: ['/add?reselect=original'], session: {
      can: key => key === 'external', quota: () => 0,
    } })
    await user.type(await screen.findByRole('searchbox', { name: '搜索课程' }), '物理')
    expect(screen.queryByText('个人课表')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '教师' })).not.toBeInTheDocument()
    expect(screen.getByText(/原订阅和全部链接地址保持不变/)).toBeInTheDocument()
    const course = await screen.findByRole('button', { name: '选择课程物理' })
    course.focus(); await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: '重选物理01班' }))
    await waitFor(() => expect(mockApi.reselectTeachingClass).toHaveBeenCalledWith('original', {
      sourceType: 'course', sourceId: 'class', sourceName: '物理01班', selectionToken: 'receipt', sessionId: 'term',
    }))
    expect(mockApi.createSubscription).not.toHaveBeenCalled()
    expect(mockApi.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    expect(await screen.findByText('重新同步 original run')).toBeInTheDocument()
  })

  it.each([
    ['missing', null],
    ['legacy', { source_version: 0 }],
    ['active', { external_state: 'active' as const }],
    ['other owner', { user_id: 'other' }],
    ['pending', { external_state: 'reselecting' as const, sync_status: 'queued' as const }],
    ['wrong type', { source_type: 'instructor' as const }],
  ])('guards %s reselection before exposing search', async (_name, override) => {
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: override === null ? [] : [mockSubscription({
      id: 'original', source_type: 'course', source_version: 1, is_personal: false, external_state: 'expired', ...override,
    })], count: 1 })
    await enableExternal()
    renderWithApp(<Add />, { routerEntries: ['/add?reselect=original'] })
    expect(await screen.findByText(_name === 'pending' ? '教学班正在重新同步' : '无法重选此订阅')).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(mockApi.createSubscription).not.toHaveBeenCalled()
    expect(mockApi.reselectTeachingClass).not.toHaveBeenCalled()
  })

  it('keeps the preserved URL notice and receipt selection when the server rejects a retry during cooldown', async () => {
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [mockSubscription({ id: 'original', source_type: 'course', source_version: 1, is_personal: false,
      external_state: 'reselecting', sync_status: 'error', sync_error_message: '采集失败',
    })], count: 1 })
    await enableExternal()
    mockApi.searchExternal.mockResolvedValue({ selection_token: 'catalog', session: { id: 'term', name: '当前学期' }, results: [{ id: 'course', name: '物理' }] })
    mockApi.searchTeachingClasses.mockResolvedValue({ selection_token: 'receipt', session: { id: 'term', name: '当前学期' }, results: [{ id: 'class', name: '物理01班' }] })
    mockApi.reselectTeachingClass.mockRejectedValue({ response: { data: { detail: { error: { code: 'COOLDOWN', message: '请在5分钟后重试' } } } } })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add?reselect=original&setup=1'] })
    await user.type(await screen.findByRole('searchbox', { name: '搜索课程' }), '物理')
    await user.click(await screen.findByRole('button', { name: '选择课程物理' }))
    await user.click(await screen.findByRole('button', { name: '重选物理01班' }))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('请在5分钟后重试'))
    expect(screen.getByText(/所选内容已保留，可重试提交/)).toHaveTextContent('请在5分钟后重试')
    expect(screen.getByText(/原订阅和全部链接地址保持不变/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重选物理01班' })).toBeInTheDocument()
    expect(mockApi.ensureDefaultSubscriptions).not.toHaveBeenCalled()
  })

  it('renders personal subscription options', async () => {
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    expect(await screen.findByText('我的全部课表')).toBeInTheDocument()
    expect(screen.getByText('我的课程')).toBeInTheDocument()
    expect(screen.getByText('我的考试')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '我的订阅' })).toHaveAttribute('href', '/dashboard')
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
      mockSubscription({ id: `sub-${i}`, source_type: 'course', source_version: 1, source_id: `c${i}`, is_personal: false }),
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
      session: { id: 'term-26', name: '2026秋' }, selection_token: 'selection-1', truncated: false,
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
        selectionToken: 'selection-1',
        sessionId: 'term-26',
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
        mockSubscription({ source_type: 'instructor', source_version: 1, source_id: 'teacher-1', is_personal: false }),
      ],
      count: 1,
    })
    mockApi.searchExternal.mockResolvedValue({
      session: { id: 'term-26', name: '2026秋' }, selection_token: 'selection-1', truncated: false,
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
    mockApi.searchExternal
      .mockRejectedValueOnce({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '搜索失败' } } } },
      })
      .mockResolvedValueOnce({
        session: { id: 'term-26', name: '2026秋' }, selection_token: 'selection-1', truncated: false,
      results: [{ id: 'teacher-1', name: '张三', extra: '计算机学院' }],
      })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByPlaceholderText('输入教师姓名或工号'), '张三')
    expect(await screen.findByText('搜索失败')).toBeInTheDocument()
    expect(screen.queryByText('未找到结果')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试搜索' }))
    expect(await screen.findByText('张三')).toBeInTheDocument()
  })

  it('discards an in-flight search when the source type changes', async () => {
    await enableExternal()
    let resolveInstructor!: (result: unknown) => void
    mockApi.searchExternal.mockImplementationOnce(
      () => new Promise((resolve) => { resolveInstructor = resolve }),
    )
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.type(await screen.findByPlaceholderText('输入教师姓名或工号'), '张三')
    await waitFor(() => expect(mockApi.searchExternal).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('tab', { name: '教室' }))
    await act(async () => {
      resolveInstructor({ session: { id: 'term-26', name: '2026秋' }, selection_token: 'selection-1', truncated: false,
      results: [{ id: 'teacher-1', name: '旧教师结果', extra: '' }] })
    })
    expect(screen.queryByText('旧教师结果')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '搜索中…' })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('输入教室编号')).toBeInTheDocument()
  })

  it('searches a department filter with the newly selected value', async () => {
    await enableExternal()
    mockApi.getDepartments.mockResolvedValue({
      departments: [
        {
          id: 'root',
          name: '全校学院',
          children: [{ id: 'dept-cs', name: '计算机学院' }],
        },
      ],
    })
    mockApi.searchExternal.mockResolvedValue({ results: [] })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    await user.click(await screen.findByRole('tab', { name: '行政班' }))
    const departmentTrigger = (await screen.findByText('请选择学院')).closest('button')
    expect(departmentTrigger).not.toBeNull()
    await user.click(departmentTrigger!)
    await user.click(screen.getByRole('button', { name: '全校学院' }))
    await user.click(screen.getByRole('treeitem', { name: '计算机学院' }))
    await waitFor(() => {
      const lastCall = mockApi.searchExternal.mock.calls.at(-1)?.[0]
      expect(lastCall).toEqual(
        expect.objectContaining({
          source_type: 'admin_class',
          department_id: 'dept-cs',
        }),
      )
    })
    await user.click(screen.getByRole('button', { name: '清除学院筛选' }))
    await waitFor(() => expect(mockApi.searchExternal).toHaveBeenLastCalledWith(expect.objectContaining({ department_id: undefined })))
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
    expect(mockApi.getSubscriptions).not.toHaveBeenCalled()
    await act(async () => resolveSetup({
      status: 'existing', subscription_ids: ['sub-1'], run_id: null, dispatch_status: 'none',
    }))
    expect(await screen.findByRole('button', { name: '已订阅' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '订阅我的课程' })).toBeEnabled()
    expect(screen.queryByText('已达订阅上限，请先删除不需要的订阅')).not.toBeInTheDocument()
  })

  it('recovers with retry when reloadSession rejects', async () => {
    const reloadSession = vi.fn()
      .mockRejectedValueOnce(new Error('session network'))
      .mockResolvedValueOnce({})
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'], session: { reloadSession } })
    expect(await screen.findByText('暂时无法确认登录状态')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '订阅我的全部课表' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '订阅我的全部课表' })).toBeEnabled()
    expect(reloadSession).toHaveBeenCalledTimes(2)
  })

  it('blocks duplicate subscriptions and offers retry when the initial list fails', async () => {
    mockApi.getSubscriptions
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        subscriptions: [mockSubscription({ source_type: 'personal_all' })],
        count: 1,
      })
    const user = userEvent.setup()
    renderWithApp(<Add />, { routerEntries: ['/add'] })
    expect(await screen.findByText('订阅状态加载失败')).toBeInTheDocument()
    expect(screen.getByText(/为避免重复添加/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '订阅我的全部课表' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '已订阅' })).toBeDisabled()
  })

  it('pilot UI searches and creates using authenticated availability while public config is closed', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: '', external: { search_types: [], create_types: [] } })
    mockApi.getMe.mockResolvedValue({ ...mockMeResponse(), cquBindStatus: 'active',
      external: { search_types: ['instructor'], create_types: ['instructor'] } })
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.searchExternal.mockResolvedValue({ session: { id: 'term', name: '当前学期' }, selection_token: 'fixture-selection', truncated: false,
      results: [{ id: 'fixture-teacher', name: '试点教师', extra: '' }] })
    mockApi.createSubscription.mockResolvedValue({ id: 'fixture-sub' })
    const user = userEvent.setup()
    render(<AppProvider><MemoryRouter initialEntries={['/add']}><Add /></MemoryRouter></AppProvider>)
    await user.type(await screen.findByRole('searchbox', { name: '搜索教师' }), '试点{Enter}')
    await user.click(await screen.findByRole('button', { name: '订阅试点教师' }))
    expect(mockApi.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'instructor', sourceId: 'fixture-teacher', selectionToken: 'fixture-selection' }))
  });
})
