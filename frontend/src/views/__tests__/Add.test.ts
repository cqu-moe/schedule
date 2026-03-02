import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithContext, mockSubscription } from '@/test-utils'

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
vi.mock('@/api/index.js', () => ({ default: mockApi }))
vi.mock('vue-sonner', () => ({ toast: mockToast }))

const { default: Add } = await import('@/views/Add.vue')

const componentStubs = {
  Navbar: { template: '<nav data-testid="navbar" />' },
  VueHcaptcha: { template: '<div data-testid="hcaptcha" />' },
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
  mockApi.getSubscriptions.mockResolvedValue({ subscriptions: existingSubs, max: 5 })
  const result = await mountWithContext(Add, {
    pinia: {
      initialState: {
        auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
      },
    },
    global: {
      stubs: componentStubs,
    },
  })
  await flushPromises()
  return result
}

describe('Add view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getCaptchaConfig.mockResolvedValue({ enabled: false, sitekey: '' })
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: [], max: 5 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // 1. Renders "添加新订阅" title
  it('renders "添加新订阅" title', async () => {
    const { wrapper } = await mountAdd()

    expect(wrapper.text()).toContain('添加新订阅')
  })

  // 2. Renders 5 source type tabs
  it('renders 5 source type tabs: 教师, 教室, 实验室, 课程, 行政班', async () => {
    const { wrapper } = await mountAdd()
    const text = wrapper.text()

    expect(text).toContain('教师')
    expect(text).toContain('教室')
    expect(text).toContain('实验室')
    expect(text).toContain('课程')
    expect(text).toContain('行政班')
  })

  // 3. Search triggers after 300ms debounce
  it('search triggers after 300ms debounce when keyword >= 2 chars', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockResolvedValue({ results: [] })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')
    expect(input.exists()).toBe(true)

    await input.setValue('张三')
    await input.trigger('input')

    // Before debounce fires - not called yet
    expect(mockApi.searchSchedule).not.toHaveBeenCalled()

    // After 300ms debounce
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockApi.searchSchedule).toHaveBeenCalledWith(
      'test-token',
      'instructor',
      '张三',
      '',
      '',
    )
  })

  // 4. Does not search for keywords < 2 chars
  it('does not search for keywords < 2 chars', async () => {
    vi.useFakeTimers()

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockApi.searchSchedule).not.toHaveBeenCalled()
  })

  // 5. Renders search results
  it('renders search results', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockResolvedValue({
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
    expect(wrapper.text()).toContain('数学学院')
  })

  // 6. Shows "已订阅" for existing subscriptions
  it('shows "已订阅" for items matching existing subscriptions', async () => {
    vi.useFakeTimers()
    const existingSub = mockSubscription({
      source_type: 'instructor',
      source_id: 'teacher-1',
      source_name: '张三',
    })
    mockApi.searchSchedule.mockResolvedValue({
      results: [
        { id: 'teacher-1', name: '张三' },
        { id: 'teacher-2', name: '李四' },
      ],
    })

    const { wrapper } = await mountAdd([existingSub])
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('已订阅')
    // The subscribed item has a disabled button with "已订阅"
    const subscribedButtons = wrapper.findAll('button').filter(b => b.text().includes('已订阅'))
    expect(subscribedButtons.length).toBe(1)
  })

  // 7. Calls createSubscription on subscribe click
  it('calls createSubscription on subscribe button click', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '张三' }],
    })
    mockApi.createSubscription.mockResolvedValue({})

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
      'test-token',
      'instructor',
      'teacher-1',
      '张三',
      null,
    )
  })

  // 8. Shows limit warning when at max subscriptions
  it('shows limit warning when at max subscriptions (>=5)', async () => {
    const subs = Array.from({ length: 5 }, (_, i) =>
      mockSubscription({
        calendar_token: `token-${i}`,
        source_id: `source-${i}`,
        source_type: 'instructor',
      }),
    )

    const { wrapper } = await mountAdd(subs)

    expect(wrapper.text()).toContain('已达最大订阅数')
  })

  // 9. Shows "未找到结果" when search returns empty
  it('shows "未找到结果" when search returns empty results', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockResolvedValue({ results: [] })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('不存在的人')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('未找到结果')
  })

  // 10. Shows error toast on API failure
  it('shows error message on API failure', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockRejectedValue({
      response: { data: { detail: '搜索失败' } },
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('搜索失败')
  })

  // 11. Shows "重新登录" link on 401/token expiration
  it('shows "重新登录" link on 401 error', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockRejectedValue({
      response: { status: 401, data: { detail: '认证已过期' } },
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('认证已过期')
    expect(wrapper.text()).toContain('重新登录')
  })

  it('shows "重新登录" link when error contains "token expired"', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockRejectedValue({
      response: { data: { detail: 'token expired' } },
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')

    await input.setValue('张三')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('重新登录')
  })

  // Error feedback: load subscriptions failure on mount
  it('shows toast error when initial subscription load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))

    // Mount directly (not via mountAdd, which overrides getSubscriptions to resolve)
    await mountWithContext(Add, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
        },
      },
      global: {
        stubs: componentStubs,
      },
    })
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  // Error feedback: load departments failure
  it('shows toast error when department load fails', async () => {
    mockApi.getDepartments.mockRejectedValue({
      response: { data: { detail: '加载院系列表失败' } },
    })

    const { wrapper } = await mountAdd()

    // Find the Tabs stub component and emit update:modelValue to trigger handleTypeChange
    const tabsStub = wrapper.findComponent(componentStubs.Tabs as any)
    await tabsStub.vm.$emit('update:modelValue', 'admin_class')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalled()
  })

  // Subscribe button calls createSubscription successfully
  it('shows success state on subscribe button after successful subscription', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '王老师', extra: '数学学院' }],
    })
    mockApi.createSubscription.mockResolvedValue({})
    mockApi.getSubscriptions.mockResolvedValue({
      subscriptions: [],
      max: 5,
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')
    await input.setValue('王老师')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    // Click subscribe button
    const subBtn = wrapper.findAll('button').find(b => b.text().includes('订阅') && !b.text().includes('已订阅'))
    await subBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.createSubscription).toHaveBeenCalled()
  })
})
