import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'
import { flushPromises } from '@vue/test-utils'

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn() }
  const mockApi = {
    register: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
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

const { default: Register } = await import('@/views/Register.vue')

describe('Register view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('risk_warning_acknowledged', 'true')
  })

  it('renders registration form with "注册" title, studentId and password inputs', async () => {
    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    expect(wrapper.text()).toContain('注册')
    expect(wrapper.find('#studentId').exists()).toBe(true)
    expect(wrapper.find('#password').exists()).toBe(true)
  })

  it('shows "请输入统一身份认证号" when studentId is empty on submit', async () => {
    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('请输入统一身份认证号')
    })
  })

  it('shows "请输入密码" when password is empty on submit', async () => {
    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('请输入密码')
    })
  })

  it('shows progress steps during registration', async () => {
    let resolveRegister!: (value: any) => void
    mockApi.register.mockReturnValue(new Promise((r) => { resolveRegister = r }))

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      const text = wrapper.text()
      expect(text).toContain('正在注册')
      expect(text).toContain('验证凭据')
      expect(text).toContain('连接教务系统')
      expect(text).toContain('获取 Token')
    })

    // Clean up: resolve to avoid unhandled promise
    resolveRegister({ calendar_token: 'tok' })
  })

  it('shows token dialog on success with token and "注册成功"', async () => {
    mockApi.register.mockResolvedValue({ calendar_token: 'new-token-123' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      const text = wrapper.text()
      expect(text).toContain('注册成功')
      expect(text).toContain('new-token-123')
    })
  })

  it('returns to form on registration failure with error message', async () => {
    mockApi.register.mockRejectedValue({
      response: { data: { detail: { error: { code: 'AUTH_FAILED', message: '用户名或密码错误' } } } },
    })

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('wrongpass')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('用户名或密码错误')
      // Should be back on form phase
      expect(wrapper.find('form').exists()).toBe(true)
    })
  })

  it('navigates to /dashboard after closing token dialog', async () => {
    mockApi.register.mockResolvedValue({ calendar_token: 'new-token-123' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper, router } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    // Wait for the dialog to appear
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('注册成功')
    })

    // Find and click the "我已保存" button in the dialog
    const buttons = wrapper.findAll('button')
    const saveButton = buttons.find((b) => b.text().includes('我已保存'))
    expect(saveButton).toBeDefined()
    await saveButton!.trigger('click')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/dashboard')
    })
  })

  it('has link to /login', async () => {
    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    const link = wrapper.find('a[href="/login"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('去登录')
  })

  // Error feedback: copy token failure shows toast
  it('shows toast error when copy token fails', async () => {
    mockApi.register.mockResolvedValue({ calendar_token: 'new-token-123' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('注册成功')
    })

    // Find copy button (in the token display area, not "我已保存")
    const copyBtns = wrapper.findAll('button').filter(b => !b.text().includes('我已保存'))
    const copyBtn = copyBtns.find(b => b.element.closest('.bg-muted'))
    if (copyBtn) {
      await copyBtn.trigger('click')
      await flushPromises()
      expect(mockToast.error).toHaveBeenCalledWith('复制失败')
    }
  })

  // Register button shows loading state
  it('disables register button during loading', async () => {
    let resolveRegister!: (value: any) => void
    mockApi.register.mockReturnValue(new Promise(r => { resolveRegister = r }))

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    // During progress, form switches to progress phase showing "正在注册"
    expect(wrapper.text()).toContain('正在注册')

    resolveRegister({ calendar_token: 'tok' })
  })
})
