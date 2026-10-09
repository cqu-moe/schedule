import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import Home from '@/views/Home'
import { renderWithApp } from '@/test-utils'

vi.mock('@/api', () => ({ default: {} }))

describe('Home', () => {
  it('renders hero, features and version footer', () => {
    renderWithApp(<Home />)

    expect(
      screen.getByRole('heading', { level: 1, name: '重庆大学课表日历订阅' }),
    ).toBeInTheDocument()
    expect(screen.getByText('自动同步')).toBeInTheDocument()
    expect(screen.getByText('标准格式')).toBeInTheDocument()
    expect(screen.getByText('安全加密')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: `v${__APP_VERSION__}` })).toHaveAttribute(
      'href',
      '/changelog',
    )
  })

  it('links authenticated bound users to dashboard setup', () => {
    renderWithApp(<Home />)

    const cta = screen.getByRole('link', { name: '开始使用' })
    expect(cta).toHaveAttribute('href', '/dashboard?setup=1')
    expect(screen.queryByText(/统一认证中心/)).not.toBeInTheDocument()
  })

  it('starts a local OAuth login with a dashboard return path', () => {
    renderWithApp(<Home />, {
      session: { user: null, isAuthenticated: false, isCquBound: false },
      routerEntries: ['/'],
    })

    const cta = screen.getByRole('link', { name: '开始使用' })
    const href = cta.getAttribute('href') ?? ''
    expect(href).toContain('/api/v2/auth/login?returnTo=')
    const redirect = new URL(href, window.location.origin).searchParams.get('returnTo')
    expect(redirect).toBe('/dashboard?setup=1')
    expect(
      screen.getByText('将前往统一认证中心 auth.cqu.moe，完成后自动返回本站'),
    ).toBeInTheDocument()
  })
})
