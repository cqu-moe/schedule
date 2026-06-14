import { describe, it, expect, vi } from 'vitest'
import { mountWithContext } from '@/test-utils'

const { mockApi } = vi.hoisted(() => {
  const mockApi = {
    getMe: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], count: 0 }),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  }
  return { mockApi }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))

const { default: Docs } = await import('@/views/Docs.vue')

describe('Docs view', () => {
  const stubs = {
    Badge: { template: '<span><slot /></span>', props: ['variant', 'class'] },
  }

  it('renders "API 文档" title', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    expect(wrapper.text()).toContain('API 文档')
  })

  it('renders endpoint descriptions', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const text = wrapper.text()

    expect(text).toContain('ICS 日历订阅')
    expect(text).toContain('格式化事件 JSON')
    expect(text).toContain('CSV 导出')
    expect(text).toContain('原始数据 JSON')
    expect(text).toContain('刷新订阅')
  })

  it('renders JSON field table with expected fields', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const text = wrapper.text()

    expect(text).toContain('semester')
    expect(text).toContain('events[].name')
  })
})
