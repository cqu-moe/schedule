import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import api from '@/api'
import { useSubscriptions } from '@/hooks/useSubscriptions'
import { AppContext } from '@/providers/app'
import { defaultMockSession } from '@/test-utils'
import { mockSubscription } from '@/test-utils'

vi.mock('@/api', () => ({
  default: {
    getSubscriptions: vi.fn(),
  },
}))

const mockApi = vi.mocked(api, true)

function wrapper({ children }: { children: ReactNode }) {
  return <AppContext.Provider value={defaultMockSession}>{children}</AppContext.Provider>
}

describe('useSubscriptions', () => {
  beforeEach(() => {
    mockApi.getSubscriptions.mockReset()
  })

  it('counts only new external subscriptions toward creation quota', async () => {
    const legacy = Array.from({ length: 6 }, (_, index) => mockSubscription({ id: `old-${index}`, source_type: 'admin_class', is_personal: false }))
    mockApi.getSubscriptions.mockResolvedValueOnce({ subscriptions: [...legacy, mockSubscription()], count: 7 })
    const quotaWrapper = ({ children }: { children: ReactNode }) => <AppContext.Provider value={{ ...defaultMockSession, quota: key => key === 'sub_limit' ? 1 : null }}>{children}</AppContext.Provider>
    const { result } = renderHook(() => useSubscriptions(), { wrapper: quotaWrapper })
    await act(() => result.current.load())
    expect(result.current.atLimit).toBe(false)
    mockApi.getSubscriptions.mockResolvedValueOnce({ subscriptions: legacy.map(s => ({ ...s, source_version: 1 })), count: 6 })
    await act(() => result.current.load())
    expect(result.current.atLimit).toBe(true)
  })

  it('loads subscriptions and optional personal_setup metadata', async () => {
    const personalSetup = {
      status: 'created' as const,
      subscription_ids: ['a', 'b', 'c'],
      run_id: 'run-1',
      dispatch_status: 'sent' as const,
    }
    mockApi.getSubscriptions.mockResolvedValueOnce({
      subscriptions: [mockSubscription()],
      count: 1,
      personal_setup: personalSetup,
    })
    const { result } = renderHook(() => useSubscriptions(), { wrapper })
    await act(() => result.current.load(true))
    expect(mockApi.getSubscriptions).toHaveBeenCalledWith(true)
    expect(result.current.subscriptions).toHaveLength(1)
    expect(result.current.personalSetup).toEqual(personalSetup)
  })

  it('treats a missing personal_setup field as null', async () => {
    mockApi.getSubscriptions.mockResolvedValueOnce({ subscriptions: [], count: 0 })
    const { result } = renderHook(() => useSubscriptions(), { wrapper })
    await act(() => result.current.load())
    expect(result.current.personalSetup).toBeNull()
  })

  it('derives share link usage and limits from session quotas', async () => {
    const sub = (id: string, shareLinks: number) =>
      mockSubscription({
        id,
        links: Array.from({ length: shareLinks }, (_, i) => ({
          id: id + '-l' + i,
          token: 'tok' + i,
          label: null,
          formats: ['ics' as const],
          is_default: i === 0,
        })),
      })
    mockApi.getSubscriptions.mockResolvedValueOnce({
      // sub a: 1 default + 2 share; sub b: 1 default + 0 share = 2 share links
      subscriptions: [sub('a', 3), sub('b', 1)],
      count: 2,
    })
    const { result } = renderHook(() => useSubscriptions(), { wrapper })
    await act(() => result.current.load())
    expect(result.current.shareLinkCount).toBe(2)
    expect(result.current.count).toBe(2)
  })

  it('reset clears subscriptions and personal setup', async () => {
    mockApi.getSubscriptions.mockResolvedValueOnce({
      subscriptions: [mockSubscription()],
      count: 1,
    })
    const { result } = renderHook(() => useSubscriptions(), { wrapper })
    await act(() => result.current.load())
    act(() => result.current.reset())
    expect(result.current.subscriptions).toHaveLength(0)
    expect(result.current.personalSetup).toBeNull()
  })
})
