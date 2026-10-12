import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import Docs from '@/views/Docs'
import { renderWithApp } from '@/test-utils'

vi.mock('@/api', () => ({ default: {} }))

const endpointTitles = ['ICS 日历订阅', '格式化事件 JSON', 'CSV 导出', '原始数据 JSON', '网页查看']

describe('Docs', () => {
  it('renders doc intro, token explanation, endpoints and field table', () => {
    renderWithApp(<Docs />)

    expect(screen.getByRole('heading', { level: 1, name: '使用指南与 API' })).toBeInTheDocument()
    expect(screen.getByText('什么是链接令牌？')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '公开端点' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '同步与更新' })).toBeInTheDocument()
    for (const title of endpointTitles) {
      expect(screen.getByRole('heading', { level: 3, name: `GET ${title}` })).toBeInTheDocument()
    }
    expect(screen.getAllByText('GET')).toHaveLength(5)
    expect(screen.getByText('semester')).toBeInTheDocument()
    expect(screen.getByText('events[].week')).toBeInTheDocument()
    expect(screen.getByText('教学周次；考试为 null')).toBeInTheDocument()
  })

  it('renders publicUrl from session in endpoint URLs', () => {
    const { container } = renderWithApp(<Docs />, {
      session: { publicUrl: 'https://cal.example.com' },
    })

    const codes = Array.from(container.querySelectorAll('code')).map((node) => node.textContent)
    expect(codes).toContain('https://cal.example.com/api/v2/calendar/abc123ef/calendar.ics')
    expect(
      codes.filter((text) => text === 'https://cal.example.com/api/v2/calendar/{令牌}/data.json'),
    ).toHaveLength(1)
    expect(codes).toContain('https://cal.example.com/view/{令牌}')
  })
})
