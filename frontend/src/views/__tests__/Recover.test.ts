import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'
import { flushPromises } from '@vue/test-utils'

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

const { default: Recover } = await import('@/views/Recover.vue')

describe('Recover view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.getCaptchaConfig.mockResolvedValue({ enabled: false, sitekey: '' })
    localStorage.clear()
    localStorage.setItem('risk_warning_acknowledged', 'true')
  })

  it('renders "找回 Token" form with studentId and password inputs', async () => {
    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    expect(wrapper.text()).toContain('找回 Token')
    expect(wrapper.find('#studentId').exists()).toBe(true)
    expect(wrapper.find('#password').exists()).toBe(true)
  })

  it('shows "请输入统一身份认证号" when studentId is empty on submit', async () => {
    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('请输入统一身份认证号')
    })
  })

  it('shows "请输入密码" when password is empty on submit', async () => {
    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('请输入密码')
    })
  })

  it('shows recovered token on success with "找回成功"', async () => {
    mockApi.recoverToken.mockResolvedValue({ calendar_token: 'recovered-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      const text = wrapper.text()
      expect(text).toContain('找回成功')
      expect(text).toContain('recovered-tok')
    })
  })

  it('shows mismatch step on PASSWORD_MISMATCH error with "密码可能已更改" and "验证" button', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } },
      },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      const text = wrapper.text()
      expect(text).toContain('密码可能已更改')
      const buttons = wrapper.findAll('button')
      const verifyButton = buttons.find((b) => b.text().includes('验证'))
      expect(verifyButton).toBeDefined()
    })
  })

  it('verify step calls recoverTokenVerify and shows success', async () => {
    // First: trigger mismatch
    mockApi.recoverToken.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } },
      },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('密码可能已更改')
    })

    // Now set up verify to succeed
    mockApi.recoverTokenVerify.mockResolvedValue({ calendar_token: 'verified-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    // Click "验证" button
    const buttons = wrapper.findAll('button')
    const verifyButton = buttons.find((b) => b.text().includes('验证'))
    expect(verifyButton).toBeDefined()
    await verifyButton!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      const text = wrapper.text()
      expect(text).toContain('找回成功')
      expect(text).toContain('verified-tok')
    })

    expect(mockApi.recoverTokenVerify).toHaveBeenCalledWith('20210001', 'password123', null)
  })

  it('navigates to /dashboard from success step via "进入仪表盘" button', async () => {
    mockApi.recoverToken.mockResolvedValue({ calendar_token: 'recovered-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper, router } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('找回成功')
    })

    // Click "进入仪表盘" button
    const buttons = wrapper.findAll('button')
    const dashButton = buttons.find((b) => b.text().includes('进入仪表盘'))
    expect(dashButton).toBeDefined()
    await dashButton!.trigger('click')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/dashboard')
    })
  })

  it('shows rate limit error on 429 response', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: {
        status: 429,
        data: { detail: '操作过于频繁' },
      },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('操作过于频繁')
    })
  })

  it('has link to /login', async () => {
    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    const link = wrapper.find('a[href="/login"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('去登录')
  })

  it('"返回" button from mismatch step goes back to form', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } },
      },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('密码可能已更改')
    })

    // Click "返回" button
    const buttons = wrapper.findAll('button')
    const backButton = buttons.find((b) => b.text().includes('返回'))
    expect(backButton).toBeDefined()
    await backButton!.trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.find('form').exists()).toBe(true)
      expect(wrapper.find('#studentId').exists()).toBe(true)
    })
  })

  // Error feedback: non-mismatch API error shows Alert
  it('shows error message for non-mismatch API errors', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: { data: { detail: { error: { message: '服务器内部错误' } } } },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('服务器内部错误')
    })
  })

  // Error feedback: verify failure shows Alert
  it('shows error message when verify fails', async () => {
    // Trigger mismatch first
    mockApi.recoverToken.mockRejectedValue({
      response: { status: 400, data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } } },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('密码可能已更改')
    })

    // Set up verify to fail
    mockApi.recoverTokenVerify.mockRejectedValue({
      response: { data: { detail: { error: { message: '验证超时' } } } },
    })

    const verifyBtn = wrapper.findAll('button').find(b => b.text().includes('验证'))
    await verifyBtn!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('验证超时')
    })
  })

  // Error feedback: copy token failure shows toast
  it('shows toast error when copy token fails', async () => {
    mockApi.recoverToken.mockResolvedValue({ calendar_token: 'recovered-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('找回成功')
    })

    // Find copy button in the token display area
    const copyBtns = wrapper.findAll('button').filter(b => !b.text().includes('进入仪表盘'))
    const copyBtn = copyBtns.find(b => b.element.closest('.bg-muted'))
    if (copyBtn) {
      await copyBtn.trigger('click')
      await flushPromises()
      expect(mockToast.error).toHaveBeenCalledWith('复制失败')
    }
  })
})
