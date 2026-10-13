import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import api from '@/api'
import { AppContext, AppProvider } from '@/providers/app'
import { captureScheduleEvent, syncPostHogIdentity } from '@/lib/posthog'
import { mockMeResponse } from '@/test-utils'

vi.mock('@/api', () => ({
  default: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
  },
}))
vi.mock('@/lib/posthog', () => ({
  syncPostHogIdentity: vi.fn(),
  captureScheduleEvent: vi.fn(),
}))

const mockApi = vi.mocked(api, true)

function Probe() {
  const app = useContext(AppContext)!
  return (
    <div>
      <span data-testid="public-url">{app.publicUrl}</span>
      <span data-testid="authenticated">{String(app.isAuthenticated)}</span>
      <span data-testid="can-sync">{String(app.can('sync'))}</span>
      <span data-testid="quota-sub">{app.quota('sub_limit') ?? 'null'}</span>
      <button onClick={() => void app.reloadSession().catch(() => {})}>reload</button>
    </div>
  )
}

function renderProvider() {
  return render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  )
}

describe('AppProvider session and config', () => {
  beforeEach(() => {
    mockApi.getMe.mockReset()
    mockApi.getConfig.mockReset()
    vi.mocked(syncPostHogIdentity).mockReset()
    vi.mocked(captureScheduleEvent).mockReset()
  })

  it('defaults publicUrl to window.location.origin and starts logged out', () => {
    mockApi.getConfig.mockResolvedValue({ public_url: window.location.origin })
    mockApi.getMe.mockReturnValue(new Promise(() => {}))
    renderProvider()
    expect(screen.getByTestId('public-url')).toHaveTextContent(window.location.origin)
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    expect(screen.getByTestId('can-sync')).toHaveTextContent('false')
  })

  it('loads config and session on mount', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })
    mockApi.getMe.mockResolvedValue(mockMeResponse())
    renderProvider()
    await waitFor(() => {
      expect(screen.getByTestId('public-url')).toHaveTextContent('https://schedule.cqu.moe')
      expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
      expect(screen.getByTestId('can-sync')).toHaveTextContent('true')
      expect(screen.getByTestId('quota-sub')).toHaveTextContent('5')
    })
    expect(syncPostHogIdentity).toHaveBeenCalledWith(mockMeResponse().user.id)
    expect(captureScheduleEvent).toHaveBeenCalledWith('app_session_ready', {
      actor_type: 'user',
      trigger: 'automatic',
      operation: 'session_ready',
      outcome: 'success',
    })
  })

  it('keeps origin fallback when config fails', async () => {
    mockApi.getConfig.mockRejectedValue(new Error('down'))
    mockApi.getMe.mockReturnValue(new Promise(() => {}))
    renderProvider()
    await waitFor(() => expect(mockApi.getConfig).toHaveBeenCalledOnce())
    expect(screen.getByTestId('public-url')).toHaveTextContent(window.location.origin)
  })

  it('swallows session load failures on mount (public visitors)', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })
    mockApi.getMe.mockRejectedValue(new Error('401'))
    renderProvider()
    await waitFor(() => expect(mockApi.getMe).toHaveBeenCalledOnce())
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    expect(syncPostHogIdentity).toHaveBeenCalledWith(null)
    expect(captureScheduleEvent).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent reloadSession calls', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })
    mockApi.getMe.mockReturnValue(new Promise(() => {}))
    renderProvider()
    const button = screen.getByText('reload')
    button.click()
    button.click()
    expect(mockApi.getMe).toHaveBeenCalledTimes(1)
  })
})

