import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountWithContext } from '@/test-utils'
import { useAuthStore } from '@/stores/auth'

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

const { default: OAuthCallback } = await import('@/views/OAuthCallback.vue')

// jsdom allows setting location.hash directly (same-document fragment change),
// which avoids redefining the non-configurable window.location property.
function setHash(hash: string) {
  window.location.hash = hash
}

// The fragment-stripped target the component computes: pathname + search.
const STRIPPED_PATH = window.location.pathname + window.location.search

describe('OAuthCallback view', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    window.location.hash = ''
    replaceStateSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {})
  })

  afterEach(() => {
    replaceStateSpy.mockRestore()
    window.location.hash = ''
  })

  it('parses #token, calls loginWithToken, navigates to Dashboard and strips the hash on success', async () => {
    setHash('#token=abc')
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper, router } = await mountWithContext(OAuthCallback)
    const authStore = useAuthStore()

    await vi.waitFor(() => {
      expect(authStore.loginWithToken).toHaveBeenCalledWith('abc')
    })

    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('Dashboard')
    })

    // Fragment stripped via history.replaceState
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', STRIPPED_PATH)
    wrapper.unmount()
  })

  it('renders bind-your-CQU message + auth.cqu.moe link for #error=cqu_unbound and does not call loginWithToken', async () => {
    setHash('#error=cqu_unbound')

    const { wrapper } = await mountWithContext(OAuthCallback)
    const authStore = useAuthStore()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('绑定')
    })

    expect(wrapper.text()).toContain('auth.cqu.moe')
    const bindLink = wrapper.find('a[href="https://auth.cqu.moe"]')
    expect(bindLink.exists()).toBe(true)
    expect(authStore.loginWithToken).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('maps #error=access_denied to "你取消了授权"', async () => {
    setHash('#error=access_denied')

    const { wrapper } = await mountWithContext(OAuthCallback)

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('你取消了授权')
    })
    expect(wrapper.find('a[href="https://auth.cqu.moe"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('maps #error=oauth_state to "登录会话已过期，请重试"', async () => {
    setHash('#error=oauth_state')

    const { wrapper } = await mountWithContext(OAuthCallback)

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('登录会话已过期')
    })
    wrapper.unmount()
  })

  it('maps an unknown / missing fragment to the generic internal error', async () => {
    setHash('')

    const { wrapper } = await mountWithContext(OAuthCallback)
    const authStore = useAuthStore()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('服务器开小差了')
    })
    expect(authStore.loginWithToken).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows an error and does not navigate when loginWithToken fails (invalid token)', async () => {
    setHash('#token=badtoken')
    mockApi.getUserInfo.mockRejectedValue(new Error('401'))

    const { wrapper, router } = await mountWithContext(OAuthCallback)
    const authStore = useAuthStore()
    const replaceSpy = vi.spyOn(router, 'replace')

    await vi.waitFor(() => {
      expect(authStore.loginWithToken).toHaveBeenCalledWith('badtoken')
    })

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Token 无效或已过期')
    })

    expect(replaceSpy).not.toHaveBeenCalled()
    // Still offers a way back to login
    expect(wrapper.find('a[href="/login"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
