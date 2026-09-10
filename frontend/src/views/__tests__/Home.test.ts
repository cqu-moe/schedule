import { describe, it, expect, vi } from 'vitest'
import { mountWithContext } from '@/test-utils'
import Home from '@/views/Home.vue'

vi.mock('@/api', () => ({
  default: {
    getMe: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
  },
}))

describe('Home view', () => {
  it('renders title "重庆大学课表日历订阅"', async () => {
    const { wrapper } = await mountWithContext(Home)
    expect(wrapper.text()).toContain('重庆大学课表日历订阅')
  })

  it('starts unauthenticated visitors at Auth binding with a setup return', async () => {
    const { wrapper } = await mountWithContext(Home)
    const link = wrapper.find('a[href*="auth.cqu.moe/cqu/bind?"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('开始使用')
    const destination = new URL(link.attributes('href')).searchParams.get('redirect')
    expect(destination).toBe('http://localhost:3000/dashboard?setup=1')
  })

  it('sets expectations about the auth.cqu.moe jump when not authenticated', async () => {
    const { wrapper } = await mountWithContext(Home)
    expect(wrapper.text()).toContain('auth.cqu.moe')
    expect(wrapper.text()).toContain('自动返回本站')
  })


  it('links active authenticated users to dashboard setup', async () => {
    const { wrapper } = await mountWithContext(Home, {
      pinia: {
        initialState: {
          session: {
            user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
            caps: {},
            cquBindStatus: 'active',
            loaded: true,
            loading: false,
          },
        },
      },
    })
    const link = wrapper.find('a[href="/dashboard?setup=1"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('开始使用')
  })

  it('sends an authenticated user with unknown binding state through Auth binding', async () => {
    const { wrapper } = await mountWithContext(Home, {
      pinia: {
        initialState: {
          session: {
            user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
            caps: { sync: true },
            cquBindStatus: undefined,
            loaded: true,
            loading: false,
          },
        },
      },
    })
    expect(wrapper.find('a[href*="auth.cqu.moe/cqu/bind?"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/dashboard?setup=1"]').exists()).toBe(false)
  })

  it('shows version in footer linking to changelog', async () => {
    const { wrapper } = await mountWithContext(Home)
    const footer = wrapper.find('footer')
    expect(footer.text()).toContain('v0.0.0-test')
    const link = footer.find('a[href="/changelog"]')
    expect(link.exists()).toBe(true)
  })
})
