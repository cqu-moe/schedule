import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithContext, mockSubscription } from '@/test-utils'

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
    getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
    getViewData: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))
vi.mock('vue-sonner', () => ({ toast: mockToast }))

const { default: Add } = await import('@/views/Add.vue')

// ── Stubs ─────────────────────────────────────────────────────────────────────

const componentStubs = {
  DepartmentTreeSelect: {
    template: '<div data-testid="dept-select" />',
    props: ['departments', 'modelValue'],
    emits: ['update:modelValue'],
  },
  Tabs: {
    template: '<div><slot /></div>',
    props: ['modelValue'],
    emits: ['update:modelValue'],
  },
  TabsList: { template: '<div><slot /></div>' },
  TabsTrigger: {
    template: '<button @click="$emit(\'click\')"><slot /></button>',
    props: ['value'],
    emits: ['click'],
  },
  Select: {
    template: '<div><slot /></div>',
    props: ['modelValue'],
    emits: ['update:modelValue'],
  },
  SelectTrigger: { template: '<div><slot /></div>' },
  SelectContent: { template: '<div><slot /></div>' },
  SelectItem: { template: '<div><slot /></div>', props: ['value'] },
  SelectValue: { template: '<span>{{ placeholder }}</span>', props: ['placeholder'] },
}

// ── Session presets ───────────────────────────────────────────────────────────

const CAPS_FULL = {
  sync: true,
  external: true,
  share: true,
  sub_limit: 5,
  share_limit: null,
  sync_interval: 60,
  manual_refresh: 5,
}

const CAPS_NO_EXTERNAL = { ...CAPS_FULL, external: false }
const CAPS_NO_SYNC = { ...CAPS_FULL, sync: false }

async function mountAdd(
  existingSubs: any[] = [],
  capsOverrides?: Partial<typeof CAPS_FULL>,
) {
  mockApi.getSubscriptions.mockResolvedValue({
    subscriptions: existingSubs,
    count: existingSubs.length,
  })
  const caps = capsOverrides ? { ...CAPS_FULL, ...capsOverrides } : CAPS_FULL
  const result = await mountWithContext(Add, {
    pinia: {
      initialState: {
        session: {
          user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
          caps,
          loaded: true,
          loading: false,
        },
        config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
      },
    },
    global: { stubs: componentStubs },
  })
  await flushPromises()
  return result
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Add view (v2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.getDepartments.mockResolvedValue({ departments: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders "添加新订阅" title', async () => {
    const { wrapper } = await mountAdd()
    expect(wrapper.text()).toContain('添加新订阅')
  })

  it('renders personal subscription section when can("sync")', async () => {
    const { wrapper } = await mountAdd()
    expect(wrapper.text()).toContain('个人课表')
    expect(wrapper.text()).toContain('我的全部课表')
    expect(wrapper.text()).toContain('我的课程')
    expect(wrapper.text()).toContain('我的考试')
  })

  it('hides personal section when !can("sync")', async () => {
    const { wrapper } = await mountAdd([], CAPS_NO_SYNC)
    expect(wrapper.text()).not.toContain('我的全部课表')
  })

  it('renders 5 external source type tabs when can("external")', async () => {
    const { wrapper } = await mountAdd()
    const text = wrapper.text()
    expect(text).toContain('教师')
    expect(text).toContain('教室')
    expect(text).toContain('实验室')
    expect(text).toContain('课程')
    expect(text).toContain('行政班')
  })

  it('shows "未开通" hint and hides search when !can("external")', async () => {
    const { wrapper } = await mountAdd([], CAPS_NO_EXTERNAL)
    expect(wrapper.text()).toContain('未开通')
    // The search input should not exist
    const input = wrapper.find('input')
    expect(input.exists()).toBe(false)
  })

  // ── Personal subscription: NO sourceId ────────────────────────────────────

  it('creates personal_all subscription WITHOUT sourceId and WITH isPersonal=true', async () => {
    mockApi.createSubscription.mockResolvedValue({ id: 'new-personal' })
    const { wrapper } = await mountAdd()

    const subscribeButtons = wrapper.findAll('button').filter(b => b.text().includes('订阅') && !b.text().includes('已订阅'))
    // Click the first personal subscribe button (我的全部课表)
    expect(subscribeButtons.length).toBeGreaterThanOrEqual(1)
    await subscribeButtons[0].trigger('click')
    await flushPromises()

    expect(mockApi.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'personal_all',
        isPersonal: true,
      }),
    )
    // MUST NOT contain sourceId
    const call = mockApi.createSubscription.mock.calls[0][0]
    expect(call).not.toHaveProperty('sourceId')
  })

  it('creates personal_courses subscription WITHOUT sourceId', async () => {
    mockApi.createSubscription.mockResolvedValue({ id: 'new-courses' })
    const { wrapper } = await mountAdd()

    const subscribeButtons = wrapper.findAll('button').filter(b => b.text().includes('订阅') && !b.text().includes('已订阅'))
    // Second personal button is personal_courses
    expect(subscribeButtons.length).toBeGreaterThanOrEqual(2)
    await subscribeButtons[1].trigger('click')
    await flushPromises()

    const call = mockApi.createSubscription.mock.calls[0][0]
    expect(call.sourceType).toBe('personal_courses')
    expect(call.isPersonal).toBe(true)
    expect(call).not.toHaveProperty('sourceId')
  })

  it('shows "已订阅" badge for already-subscribed personal type', async () => {
    const personalSub = mockSubscription({
      source_type: 'personal_all',
      is_personal: true,
    })
    const { wrapper } = await mountAdd([personalSub])

    const subscribedBtns = wrapper.findAll('button').filter(b => b.text().includes('已订阅'))
    expect(subscribedBtns.length).toBeGreaterThanOrEqual(1)
  })

  it('shows success toast after personal subscribe', async () => {
    mockApi.createSubscription.mockResolvedValue({ id: 'p-new' })
    const { wrapper } = await mountAdd()

    const subscribeButtons = wrapper.findAll('button').filter(b => b.text().includes('订阅') && !b.text().includes('已订阅'))
    await subscribeButtons[0].trigger('click')
    await flushPromises()

    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('已订阅'))
  })

  // ── External search ────────────────────────────────────────────────────────

  it('search triggers api.searchExternal after 300ms debounce', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({ results: [] })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')
    expect(input.exists()).toBe(true)

    await input.setValue('张三')
    await input.trigger('input')

    expect(mockApi.searchExternal).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockApi.searchExternal).toHaveBeenCalledWith(
      expect.objectContaining({ source_type: 'instructor', keyword: '张三' }),
    )
  })

  it('does not search for keywords < 2 chars (non-admin_class)', async () => {
    vi.useFakeTimers()

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockApi.searchExternal).not.toHaveBeenCalled()
  })

  it('renders external search results', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({
      results: [
        { id: 'teacher-1', name: '张三', extra: '计算机学院' },
        { id: 'teacher-2', name: '李四', extra: '数学学院' },
      ],
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('计算机学院')
    expect(wrapper.text()).toContain('李四')
  })

  it('shows "已订阅" for items matching existing external subscriptions', async () => {
    vi.useFakeTimers()
    const existingSub = mockSubscription({
      source_type: 'instructor',
      source_id: 'teacher-1',
      source_name: '张三',
    })
    mockApi.searchExternal.mockResolvedValue({
      results: [
        { id: 'teacher-1', name: '张三', extra: '' },
        { id: 'teacher-2', name: '李四', extra: '' },
      ],
    })

    const { wrapper } = await mountAdd([existingSub])
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    const subscribedButtons = wrapper.findAll('button').filter(b => b.text().includes('已订阅'))
    // 1 disabled "已订阅" for the already-subscribed external result
    expect(subscribedButtons.length).toBeGreaterThanOrEqual(1)
  })

  it('calls api.createSubscription WITH sourceId for external subscribe', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '张三', extra: '' }],
    })
    // Mock createSubscription to resolve only on the second call (first is personal if any)
    mockApi.createSubscription.mockResolvedValue({ id: 'new-sub' })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    // Find the subscribe button specifically next to the search result item (张三).
    // The result items are rendered in divs containing the name + a button.
    // We locate the result row by name and then find its button.
    const resultRows = wrapper.findAll('div.flex.items-center.justify-between')
    const resultRow = resultRows.find(r => r.text().includes('张三') && r.text().includes('订阅'))
    expect(resultRow).toBeDefined()

    const subscribeBtn = resultRow!.findAll('button').find(
      b => b.text().includes('订阅') && !b.text().includes('已订阅'),
    )
    expect(subscribeBtn).toBeDefined()
    await subscribeBtn!.trigger('click')
    await flushPromises()

    // Find the call that has sourceId (the external one)
    const calls = mockApi.createSubscription.mock.calls
    const externalCall = calls.find(c => c[0].sourceId === 'teacher-1')
    expect(externalCall).toBeDefined()
    expect(externalCall![0]).toMatchObject({
      sourceType: 'instructor',
      sourceId: 'teacher-1',
      sourceName: '张三',
    })
    expect(externalCall![0].isPersonal).not.toBe(true)
  })

  it('shows "未找到结果" when search returns empty', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({ results: [] })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('不存在的人')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('未找到结果')
  })

  it('shows inline error in Alert when search fails', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockRejectedValue({
      response: {
        data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '搜索失败' } } },
      },
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('搜索失败')
  })

  // ── 409 CQU_SESSION_INACTIVE ───────────────────────────────────────────────

  it('shows friendly "CQU 未绑定" message on 409 CQU_SESSION_INACTIVE', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockRejectedValue({
      response: {
        data: { detail: { error: { code: 'CQU_SESSION_INACTIVE', message: '未绑定' } } },
      },
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('教师名称')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    // Should mention auth.cqu.moe
    expect(wrapper.text()).toContain('auth.cqu.moe')
  })

  // ── Sub limit ─────────────────────────────────────────────────────────────────

  it('disables external subscribe buttons when at sub_limit', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '张三', extra: '' }],
    })

    // 5 subs = at limit (sub_limit: 5)
    const fiveSubs = Array.from({ length: 5 }, (_, i) =>
      mockSubscription({ id: `sub-${i}` }),
    )
    const { wrapper } = await mountAdd(fiveSubs)
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    // Limit warning should show
    expect(wrapper.text()).toContain('已达最大订阅数')
  })

  // ── Department loading ────────────────────────────────────────────────────────

  it('loads departments when switching to admin_class tab', async () => {
    const { wrapper } = await mountAdd()

    const tabsStub = wrapper.findComponent(componentStubs.Tabs as any)
    await tabsStub.vm.$emit('update:modelValue', 'admin_class')
    await flushPromises()

    expect(mockApi.getDepartments).toHaveBeenCalled()
  })

  // ── Load error ────────────────────────────────────────────────────────────────

  it('shows toast error when initial subscription load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValueOnce(new Error('network'))

    await mountWithContext(Add, {
      pinia: {
        initialState: {
          session: {
            user: null,
            caps: null,
            loaded: true,
            loading: false,
          },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
      global: { stubs: componentStubs },
    })
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })
})
