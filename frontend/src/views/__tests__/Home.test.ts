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

  it('links to auth.cqu.moe/login with redirect param when not authenticated', async () => {
    const { wrapper } = await mountWithContext(Home)
    // Must carry ?redirect= so the user returns to current page after login.
    const bareLink = wrapper.find('a[href="https://auth.cqu.moe/login"]')
    expect(bareLink.exists()).toBe(false)

    const link = wrapper.find('a[href*="/login?redirect="]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('登录 / 注册')
  })

  it('sets expectations about the auth.cqu.moe jump when not authenticated', async () => {
    const { wrapper } = await mountWithContext(Home)
    expect(wrapper.text()).toContain('auth.cqu.moe')
    expect(wrapper.text()).toContain('自动返回本站')
  })


  it('links to /dashboard when authenticated', async () => {
    const { wrapper } = await mountWithContext(Home, {
      pinia: {
        initialState: {
          session: {
            user: { id: 'u1', name: '张三', email: 'z@cqu.edu.cn', role: 'student' },
            caps: {},
            loaded: true,
            loading: false,
          },
        },
      },
    })
    const link = wrapper.find('a[href="/dashboard"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('开始使用')
  })

  it('shows version in footer linking to changelog', async () => {
    const { wrapper } = await mountWithContext(Home)
    const footer = wrapper.find('footer')
    expect(footer.text()).toContain('v0.0.0-test')
    const link = footer.find('a[href="/changelog"]')
    expect(link.exists()).toBe(true)
  })
})
