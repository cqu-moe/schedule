import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Home from '@/views/Home'
import { mockMeResponse, renderWithApp } from '@/test-utils'
import { AppProvider } from '@/providers/app'
import api from '@/api'
import type { MeResponse } from '@/types/api'

vi.mock('@/api', () => ({ default: { getConfig: vi.fn(), getMe: vi.fn() } }))
vi.mock('@/lib/posthog', () => ({ syncPostHogIdentity: vi.fn(), captureScheduleEvent: vi.fn() }))

describe('Home', () => {
  it('renders hero and features', () => {
    renderWithApp(<Home />)

    expect(
      screen.getByRole('heading', { level: 1, name: /课表，放进.*你常用的日历/  }),
    ).toBeInTheDocument()
    expect(screen.getByText('自动同步')).toBeInTheDocument()
    expect(screen.getByText('标准格式')).toBeInTheDocument()
    expect(screen.getByText('分享可控')).toBeInTheDocument()
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

  it.each(['authenticated', 'visitor'] as const)('waits for a slow session before offering the %s start action', async kind => {
    let resolveSession!: (value: MeResponse) => void
    let rejectSession!: (error: unknown) => void
    vi.mocked(api.getConfig).mockResolvedValue({ public_url: window.location.origin })
    vi.mocked(api.getMe).mockReturnValue(new Promise((resolve, reject) => {
      resolveSession = resolve
      rejectSession = reject
    }))
    render(<AppProvider><MemoryRouter><Home /></MemoryRouter></AppProvider>)
    expect(screen.getByRole('status')).toHaveTextContent('正在确认登录状态')
    expect(screen.queryByRole('link', { name: '开始使用' })).not.toBeInTheDocument()
    expect(screen.queryByText(/将前往统一认证中心/)).not.toBeInTheDocument()
    await act(async () => {
      if (kind === 'authenticated') resolveSession({ ...mockMeResponse(), cquBindStatus: 'active' })
      else rejectSession({ response: { status: 401 } })
    })
    expect(screen.getByRole('link', { name: '开始使用' })).toHaveAttribute('href', kind === 'authenticated'
      ? '/dashboard?setup=1' : '/api/v2/auth/login?returnTo=%2Fdashboard%3Fsetup%3D1')
  })
})
