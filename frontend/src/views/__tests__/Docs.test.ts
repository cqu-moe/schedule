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

  it('renders all five endpoint cards', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const text = wrapper.text()

    expect(text).toContain('ICS 日历订阅')
    expect(text).toContain('格式化事件 JSON')
    expect(text).toContain('CSV 导出')
    expect(text).toContain('原始数据 JSON')
    expect(text).toContain('网页查看')
  })

  it('renders v2 calendar API paths and no v1 paths', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const html = wrapper.html()

    expect(html).toContain('/api/v2/calendar/')
    expect(html).not.toContain('/api/v1/')
  })

  it('renders /view/{令牌} for the web format', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    expect(wrapper.html()).toContain('/view/')
  })

  it('renders refresh info section without Authorization header snippet', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const html = wrapper.html()

    expect(wrapper.text()).toContain('刷新订阅')
    // No Authorization: Bearer code block (the v1 pattern) — explanatory prose is fine
    expect(html).not.toContain('Authorization: Bearer')
  })

  it('renders JSON field table with expected fields', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const text = wrapper.text()

    expect(text).toContain('semester')
    expect(text).toContain('events[].name')
  })

  it('renders link token explanation mentioning 默认链接 and 共享链接', async () => {
    const { wrapper } = await mountWithContext(Docs, { global: { stubs } })
    const text = wrapper.text()

    expect(text).toContain('默认链接')
    expect(text).toContain('共享链接')
  })
})
