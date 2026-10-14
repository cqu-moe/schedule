import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
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
})
