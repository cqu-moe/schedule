import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'

const { mockApi } = vi.hoisted(() => {
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
  return { mockApi }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))

const { default: Login } = await import('@/views/Login.vue')

const VALID_TOKEN = 'a'.repeat(32)

// Stub shadcn-vue components that depend on @vueuse/core (reactiveOmit, useVModel)
// which is globally mocked in test-setup.ts with only useColorMode
const uiStubs = {
  Label: { template: '<label><slot /></label>', props: ['for'] },
  Input: {
    template: '<input :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    props: ['modelValue', 'type', 'id', 'autocomplete', 'spellcheck', 'placeholder'],
    emits: ['update:modelValue'],
  },
}

describe('Login view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    // Acknowledge risk warning so it doesn't interfere
    localStorage.setItem('risk_warning_acknowledged', 'true')
  })

  function mountLogin(initialRoute = '/login') {
    return mountWithContext(Login, {
      initialRoute,
      global: {
        stubs: uiStubs,
      },
    })
  }

  it('renders login form with title "登录" and password input', async () => {
    const { wrapper } = await mountLogin()

    expect(wrapper.text()).toContain('登录')
    const input = wrapper.find('input[type="password"]')
    expect(input.exists()).toBe(true)
  })

  it('shows "Token 格式不正确" for empty token on submit', async () => {
    const { wrapper } = await mountLogin()

    await wrapper.find('form').trigger('submit')

    expect(wrapper.text()).toContain('Token 格式不正确')
  })

  it('shows "Token 格式不正确" for short token (<32 chars) on submit', async () => {
    const { wrapper } = await mountLogin()

    const input = wrapper.find('input[type="password"]')
    await input.setValue('short-token')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.text()).toContain('Token 格式不正确')
  })

  it('navigates to /dashboard on successful login', async () => {
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper, router } = await mountLogin()

    const input = wrapper.find('input[type="password"]')
    await input.setValue(VALID_TOKEN)
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/dashboard')
    })
  })

  it('respects redirect query param', async () => {
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper, router } = await mountWithContext(Login, {
      initialRoute: '/login?redirect=/add',
      global: {
        stubs: uiStubs,
      },
    })

    const input = wrapper.find('input[type="password"]')
    await input.setValue(VALID_TOKEN)
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/add')
    })
  })

  it('shows "Token 无效或已过期" on invalid token', async () => {
    mockApi.getUserInfo.mockRejectedValue(new Error('401'))

    const { wrapper } = await mountLogin()

    const input = wrapper.find('input[type="password"]')
    await input.setValue(VALID_TOKEN)
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Token 无效或已过期')
    })
  })

  it('has links to /register and /recover', async () => {
    const { wrapper } = await mountLogin()

    const registerLink = wrapper.find('a[href="/register"]')
    expect(registerLink.exists()).toBe(true)
    expect(registerLink.text()).toContain('注册')

    const recoverLink = wrapper.find('a[href="/recover"]')
    expect(recoverLink.exists()).toBe(true)
    expect(recoverLink.text()).toContain('找回')
  })

  it('renders the auth.cqu.moe login button (a non-form button, separate from the token form)', async () => {
    const { wrapper } = await mountLogin()

    const oauthButton = wrapper.findAll('button').find((b) => b.text().includes('auth.cqu.moe'))
    expect(oauthButton).toBeTruthy()
    // It must be a plain button (type="button"), not the form submit button.
    expect(oauthButton!.attributes('type')).toBe('button')
  })
})
