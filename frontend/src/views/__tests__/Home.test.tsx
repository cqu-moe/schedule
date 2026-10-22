import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import Home from '@/views/Home'
import { mockMeResponse, renderWithApp } from '@/test-utils'
import { AppProvider } from '@/providers/app'
import api from '@/api'
import type { MeResponse } from '@/types/api'

vi.mock('@/api', () => ({ default: { getConfig: vi.fn(), getMe: vi.fn() } }))
vi.mock('@/lib/posthog', () => ({ syncPostHogIdentity: vi.fn(), captureScheduleEvent: vi.fn() }))

describe('Home', () => {
  it('links authenticated bound users to dashboard setup', () => {
    renderWithApp(<Home />)

    const cta = screen.getByRole('link', { name: '打开我的订阅' })
    expect(cta).toHaveAttribute('href', '/dashboard?setup=1')
    expect(screen.queryByText(/auth\.cqu\.moe/)).not.toBeInTheDocument()
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
      screen.getByText('通过 auth.cqu.moe 登录并绑定重庆大学统一认证账号'),
    ).toBeInTheDocument()
  })

  it.each(['authenticated', 'visitor'] as const)(
    'waits for a slow session before offering the %s start action',
    async (kind) => {
      let resolveSession!: (value: MeResponse) => void
      let rejectSession!: (error: unknown) => void
      vi.mocked(api.getConfig).mockResolvedValue({ public_url: window.location.origin })
      vi.mocked(api.getMe).mockReturnValue(
        new Promise((resolve, reject) => {
          resolveSession = resolve
          rejectSession = reject
        }),
      )
      render(
        <AppProvider>
          <MemoryRouter>
            <Home />
          </MemoryRouter>
        </AppProvider>,
      )
      expect(screen.getByRole('status')).toHaveTextContent('正在确认登录状态')
      expect(screen.queryByRole('link', { name: /开始使用|打开我的订阅/ })).not.toBeInTheDocument()
      expect(screen.queryByText(/auth\.cqu\.moe/)).not.toBeInTheDocument()
      await act(async () => {
        if (kind === 'authenticated')
          resolveSession({ ...mockMeResponse(), cquBindStatus: 'active' })
        else rejectSession({ response: { status: 401 } })
      })
      expect(
        screen.getByRole('link', { name: kind === 'authenticated' ? '打开我的订阅' : '开始使用' }),
      ).toHaveAttribute(
        'href',
        kind === 'authenticated'
          ? '/dashboard?setup=1'
          : '/api/v2/auth/login?returnTo=%2Fdashboard%3Fsetup%3D1',
      )
    },
  )

  it.each([
    ['unbound', '绑定统一认证账号', 'https://auth.cqu.moe/cqu/bind'],
    ['deleting', '查看解绑进度', 'https://auth.cqu.moe/settings/cqu'],
  ] as const)('keeps the %s session on the correct auth flow', (cquBindStatus, label, target) => {
    renderWithApp(<Home />, {
      session: { cquBindStatus, isCquBound: false },
      routerEntries: ['/?source=home#how'],
    })
    const href = screen.getByRole('link', { name: label }).getAttribute('href')!
    expect(href.split('?')[0]).toBe(target)
    if (cquBindStatus === 'unbound') {
      const redirect = new URL(new URL(href).searchParams.get('redirect')!)
      expect(redirect.pathname + redirect.search + redirect.hash).toBe(
        '/dashboard?source=home&setup=1#how',
      )
    }
    expect(screen.queryByRole('link', { name: '打开我的订阅' })).not.toBeInTheDocument()
  })

  it('offers retry rather than a login when the session is unavailable', async () => {
    const user = userEvent.setup()
    const reloadSession = vi.fn().mockRejectedValue(new Error('offline'))
    renderWithApp(<Home />, {
      session: { user: null, isAuthenticated: false, sessionError: 'unavailable', reloadSession },
    })
    expect(screen.queryByRole('link', { name: '开始使用' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试登录状态' }))
    expect(reloadSession).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('暂时无法确认登录状态')
  })

  it('switches sample days and opens selected course details with keyboard focus restored', async () => {
    const user = userEvent.setup()
    renderWithApp(<Home />)
    await user.click(screen.getByRole('button', { name: '查看周三安排' }))
    expect(screen.getByRole('button', { name: '查看周三安排' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('button', { name: /^大学物理 10/ })).not.toBeInTheDocument()
    const course = screen.getByRole('button', { name: /半导体物理与器件基础/ })
    course.focus()
    await user.keyboard('{Enter}')
    const dialog = screen.getByRole('dialog', { name: '半导体物理与器件基础' })
    expect(within(dialog).getByText(/2026 年 10 月 21 日/)).toBeInTheDocument()
    expect(within(dialog).getByText('第一教学楼 A308')).toBeInTheDocument()
    expect(within(dialog).getByText(/不是真实课表/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(course).toHaveFocus()
  })
})
