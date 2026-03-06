import { describe, it, expect } from 'vitest'
import { mountWithContext } from '@/test-utils'
import Home from '@/views/Home.vue'

describe('Home view', () => {
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

  it('shows version in footer linking to changelog', async () => {
    const { wrapper } = await mountWithContext(Home)
    const footer = wrapper.find('footer')
    expect(footer.text()).toContain('v0.0.0-test')
    const link = footer.find('a[href="/changelog"]')
    expect(link.exists()).toBe(true)
  })
})
