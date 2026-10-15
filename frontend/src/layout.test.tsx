import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, RouterProvider } from 'react-router'
import { ThemeProvider } from '@cqu-moe/ui'
import api from '@/api'
import { mockMeResponse } from '@/test-utils'
import { AppProvider } from '@/providers/app'
import Layout from '@/layout'

vi.mock('@/lib/posthog', () => ({
  captureSchedulePageview: vi.fn(),
  syncPostHogReplay: vi.fn(),
  captureScheduleEvent: vi.fn(),
  syncPostHogIdentity: vi.fn(),
}))

vi.mock('@/api', () => ({
  default: {
    getConfig: vi.fn(),
    getMe: vi.fn(),
  },
}))

function renderShell() {
  const router = createMemoryRouter([
    {
      element: <Layout />,
      children: [{ path: '/api-docs', element: <div>Shell content</div> }],
    },
  ], { initialEntries: ['/api-docs'] })

  return render(
    <ThemeProvider>
      <AppProvider>
        <RouterProvider router={router} />
      </AppProvider>
    </ThemeProvider>,
  )
}

describe('Layout appearance menu', () => {
  beforeAll(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn().mockReturnValue(false),
    })))
  })

  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(api.getConfig).mockResolvedValue({ public_url: window.location.origin })
    vi.mocked(api.getMe).mockResolvedValue(mockMeResponse())
  })

  it('closes after selecting a theme', async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole('button', { name: '外观设置' }))
    await user.click(screen.getByRole('menuitemradio', { name: '深色' }))

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
  })

  it('closes on Escape without changing the selected theme', async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole('button', { name: '外观设置' }))
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it.each([
    ['/', '/dashboard', '我的订阅', true],
    ['/add', '/View/MiXeD-token', '课表日历', false],
  ] as const)('shows the target shell for %s → %s while retaining a cancellable draft', async (source, target, heading, hasNavigation) => {
    const user = userEvent.setup()
    let resolveCalendar!: () => void
    const calendarReady = new Promise<void>(resolve => { resolveCalendar = resolve })
    const router = createMemoryRouter([{
      element: <Layout />,
      children: [
        { path: source, element: <><input aria-label="订阅名称" /><Link to={target}>打开课表</Link></> },
        { path: target, lazy: async () => {
          await calendarReady
          return { Component: () => <h1>日历内容</h1> }
        } },
      ],
    }], { initialEntries: [source] })
    render(<ThemeProvider><AppProvider><RouterProvider router={router} /></AppProvider></ThemeProvider>)
    const draft = await screen.findByRole('textbox', { name: '订阅名称' })
    await user.type(draft, '保留的草稿')
    await user.click(screen.getByRole('link', { name: '打开课表' }))
    expect(draft).toHaveValue('保留的草稿')
    expect(draft).toBeInTheDocument()
    expect(draft).not.toBeVisible()
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    expect(Boolean(screen.queryByRole('button', { name: '打开导航' }))).toBe(hasNavigation)
    const skipTarget = screen.getByRole('link', { name: '跳至正文' }).getAttribute('href')!.slice(1)
    expect(document.getElementById(skipTarget)).toBe(screen.getByRole('main'))
    await act(() => router.navigate(-1))
    expect(screen.getByRole('textbox', { name: '订阅名称' })).toHaveValue('保留的草稿')
    expect(document.getElementById(skipTarget)).toBe(screen.getByRole('main'))
    await act(async () => { resolveCalendar() })
    expect(screen.queryByRole('heading', { name: '日历内容' })).not.toBeInTheDocument()
  })
})
