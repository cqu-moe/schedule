import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'

const { mockApi } = vi.hoisted(() => {
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
  return { mockApi }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index.js', () => ({ default: mockApi }))

const { default: Home } = await import('@/views/Home.vue')

describe('Home view', () => {
  beforeEach(() => {
    mockApi.getHealth.mockReset()
    mockApi.getHealth.mockResolvedValue({ status: 'ok' })
  })

  it('renders title "重庆大学课表日历订阅"', async () => {
    const { wrapper } = await mountWithContext(Home)
    expect(wrapper.text()).toContain('重庆大学课表日历订阅')
  })

  it('links to /register when not authenticated', async () => {
    const { wrapper } = await mountWithContext(Home)
    const link = wrapper.find('a[href="/register"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('开始使用')
  })

  it('links to /dashboard when authenticated', async () => {
    const { wrapper } = await mountWithContext(Home, {
      pinia: {
        initialState: {
          auth: { token: 'test-token' },
        },
      },
    })
    const link = wrapper.find('a[href="/dashboard"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('开始使用')
  })

  it('shows version from health API when commit is not "dev"', async () => {
    mockApi.getHealth.mockResolvedValue({ commit: 'abc1234', date: '2026-03-01' })

    const { wrapper } = await mountWithContext(Home)

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('abc1234 (2026-03-01)')
    })
  })

  it('does not show version when commit is "dev"', async () => {
    mockApi.getHealth.mockResolvedValue({ commit: 'dev', date: 'unknown' })

    const { wrapper } = await mountWithContext(Home)

    // Wait for the onMounted to complete
    await vi.waitFor(() => {
      expect(mockApi.getHealth).toHaveBeenCalled()
    })

    // version should remain empty, so neither "dev" nor a parenthesized date should appear in footer
    expect(wrapper.text()).not.toContain('dev')
  })
})
