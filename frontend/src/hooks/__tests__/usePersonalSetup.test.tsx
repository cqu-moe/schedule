import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import api, { redirect } from '@/api'
import { usePersonalSetup } from '@/hooks/usePersonalSetup'
import { AppContext } from '@/providers/app'
import { defaultMockSession, mockMeResponse } from '@/test-utils'
import type { DefaultSubscriptionsResponse, MeResponse } from '@/types/api'

const mocks = vi.hoisted(() => ({
  ensureDefaultSubscriptions: vi.fn(),
  reloadSession: vi.fn(),
}))

vi.mock('@/api', () => ({
  default: {
    ensureDefaultSubscriptions: mocks.ensureDefaultSubscriptions,
  },
  redirect: { fn: vi.fn() },
}))

const fullCaps = mockMeResponse().caps

const created: DefaultSubscriptionsResponse = {
  status: 'created',
  subscription_ids: ['a', 'b', 'c'],
  run_id: 'run-1',
  dispatch_status: 'sent',
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="pathname">{location.pathname}{location.search}</span>
}

function createWrapper(initialRoute: string, sessionOverrides = {}) {
  const value = {
    ...defaultMockSession,
    reloadSession: mocks.reloadSession,
    ...sessionOverrides,
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppContext.Provider value={value}>
        <MemoryRouter initialEntries={[initialRoute]}>
          {children}
          <LocationProbe />
        </MemoryRouter>
      </AppContext.Provider>
    )
  }
}

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    ...mockMeResponse(),
    cquBindStatus: 'active',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.reloadSession.mockResolvedValue(me())
  mocks.ensureDefaultSubscriptions.mockResolvedValue(created)
})

describe('usePersonalSetup', () => {
  it('does nothing without setup=1', async () => {
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/dashboard'),
    })
    await act(() => result.current.begin())
    expect(mocks.reloadSession).not.toHaveBeenCalled()
    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
  })

  it('coalesces repeated begin calls into one defaults POST', async () => {
    let resolve!: (value: DefaultSubscriptionsResponse) => void
    mocks.ensureDefaultSubscriptions.mockReturnValue(new Promise((done) => { resolve = done }))
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/dashboard?setup=1'),
    })
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    act(() => {
      first = result.current.begin()
      second = result.current.begin()
    })
    await waitFor(() => expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolve(created)
      await Promise.all([first!, second!])
    })
  })

  it('removes setup without POST when sync is not enabled', async () => {
    mocks.reloadSession.mockResolvedValueOnce(me({ caps: { calendar: { ...fullCaps.calendar, sync: false } } }))
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/add?setup=1&from=menu#personal'),
    })
    await act(() => result.current.begin())
    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
  })

  it('redirects an explicitly unbound session to Auth binding without POST', async () => {
    mocks.reloadSession.mockResolvedValueOnce(me({ cquBindStatus: 'revoked' }))
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/add?setup=1&from=menu'),
    })
    await act(() => result.current.begin())
    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    expect(redirect.fn).toHaveBeenCalledOnce()
    const authUrl = new URL((redirect.fn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
    expect(authUrl.pathname).toBe('/cqu/bind')
    expect(authUrl.searchParams.get('redirect')).toContain('/add?setup=1&from=menu')
  })

  it('waits for deleting to finish without starting a new bind or sync', async () => {
    mocks.reloadSession.mockResolvedValueOnce(me({ cquBindStatus: 'deleting' }))
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/add?setup=1'),
    })
    await act(() => result.current.begin())
    expect(mocks.ensureDefaultSubscriptions).not.toHaveBeenCalled()
    expect(redirect.fn).not.toHaveBeenCalled()
    expect(result.current.error).toContain('解绑')
  })

  it('uses the refreshed session, creates defaults, and strips setup', async () => {
    let resolve!: (value: DefaultSubscriptionsResponse) => void
    mocks.ensureDefaultSubscriptions.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/dashboard?setup=1'),
    })
    let promise: Promise<void> | undefined
    act(() => { promise = result.current.begin() })
    await waitFor(() => expect(result.current.preparing).toBe(true))
    await act(async () => {
      resolve(created)
      await promise
    })
    expect(mocks.reloadSession).toHaveBeenCalledTimes(1)
    expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(1)
    expect(result.current.startedThisVisit).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('keeps setup after failure and succeeds on an explicit retry', async () => {
    mocks.ensureDefaultSubscriptions
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(created)
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/dashboard?setup=1&from=auth'),
    })
    await act(() => result.current.begin())
    expect(result.current.error).toBeTruthy()
    await act(() => result.current.begin())
    expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
  })

  it('sends a newly created Add visit to Dashboard', async () => {
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/add?setup=1&from=menu'),
    })
    await act(() => result.current.begin())
    expect(result.current.startedThisVisit).toBe(true)
  })

  it('keeps an existing account on Add (no dashboard jump)', async () => {
    mocks.ensureDefaultSubscriptions.mockResolvedValueOnce({
      status: 'existing',
      subscription_ids: [],
      run_id: null,
      dispatch_status: 'sent',
    })
    const { result } = renderHook(() => usePersonalSetup(), {
      wrapper: createWrapper('/add?setup=1&from=menu'),
    })
    await act(() => result.current.begin())
    expect(mocks.ensureDefaultSubscriptions).toHaveBeenCalledTimes(1)
  })
})
