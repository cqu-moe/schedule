// TODO(FE-2): full Add view rewrite when the v2 search/subscribe UI (external
// caps gating, session_id selection, etc.) is implemented.
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
  SelectValue: {
    template: '<span>{{ placeholder }}</span>',
    props: ['placeholder'],
  },
}

async function mountAdd(existingSubs: any[] = []) {
  mockApi.getSubscriptions.mockResolvedValue({ subscriptions: existingSubs, count: existingSubs.length })
  const result = await mountWithContext(Add, {
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
    global: {
      stubs: componentStubs,
    },
  })
  await flushPromises()
  return result
}

describe('Add view (FE-1 shim)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], count: 0 })
    mockApi.getDepartments.mockResolvedValue({ departments: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders "添加新订阅" title', async () => {
    const { wrapper } = await mountAdd()
    expect(wrapper.text()).toContain('添加新订阅')
  })

  it('renders 5 source type tabs', async () => {
    const { wrapper } = await mountAdd()
    const text = wrapper.text()
    expect(text).toContain('教师')
    expect(text).toContain('教室')
    expect(text).toContain('实验室')
    expect(text).toContain('课程')
    expect(text).toContain('行政班')
  })

  it('search triggers api.searchExternal after 300ms debounce', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({ results: [] })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')
    expect(input.exists()).toBe(true)

    await input.setValue('张三')
    await input.trigger('input')

    // Before debounce fires
    expect(mockApi.searchExternal).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockApi.searchExternal).toHaveBeenCalledWith(
      expect.objectContaining({ source_type: 'instructor', keyword: '张三' }),
    )
  })

  it('does not search for keywords < 2 chars', async () => {
    vi.useFakeTimers()

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockApi.searchExternal).not.toHaveBeenCalled()
  })

  it('renders search results', async () => {
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

  it('shows "已订阅" for items matching existing subscriptions', async () => {
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

    expect(wrapper.text()).toContain('已订阅')
    const subscribedButtons = wrapper.findAll('button').filter(b => b.text().includes('已订阅'))
    expect(subscribedButtons.length).toBe(1)
  })

  it('calls api.createSubscription with v2 body on subscribe click', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '张三', extra: '' }],
    })
    mockApi.createSubscription.mockResolvedValue({ id: 'new-sub' })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    const subscribeBtn = wrapper.findAll('button').find(b => b.text().includes('订阅') && !b.text().includes('已订阅'))
    expect(subscribeBtn).toBeDefined()
    await subscribeBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'instructor', sourceId: 'teacher-1', sourceName: '张三' }),
    )
  })

  it('shows "未找到结果" when search returns empty results', async () => {
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

  it('shows error message in Alert when search API fails', async () => {
    vi.useFakeTimers()
    mockApi.searchExternal.mockRejectedValue({
      response: { data: { detail: { error: { code: 'UPSTREAM_ERROR', message: '搜索失败' } } } },
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    // v2 Add: shows error inline in Alert (not toast) for search errors
    expect(wrapper.text()).toContain('搜索失败')
  })

  it('shows toast error when initial subscription load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))

    await mountWithContext(Add, {
      pinia: {
        initialState: {
          session: { user: null, caps: null, loaded: true, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
      global: { stubs: componentStubs },
    })
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  it('loads departments when switching to admin_class tab', async () => {
    const { wrapper } = await mountAdd()

    const tabsStub = wrapper.findComponent(componentStubs.Tabs as any)
    await tabsStub.vm.$emit('update:modelValue', 'admin_class')
    await flushPromises()

    expect(mockApi.getDepartments).toHaveBeenCalled()
  })
})
