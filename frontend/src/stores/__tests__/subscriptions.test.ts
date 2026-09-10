import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockApi = vi.hoisted(() => ({
  getSubscriptions: vi.fn(),
}))

vi.mock('@/api', () => ({ default: mockApi }))

describe('subscriptions store setup metadata', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi.getSubscriptions.mockReset()
  })

  it('loads optional personal_setup metadata and clears it on reset', async () => {
    const personalSetup = {
      status: 'created' as const,
      subscription_ids: ['a', 'b', 'c'],
      run_id: 'run-1',
      dispatch_status: 'sent' as const,
    }
    mockApi.getSubscriptions.mockResolvedValueOnce({
      subscriptions: [],
      count: 0,
      personal_setup: personalSetup,
    })
    const { useSubscriptionsStore } = await import('@/stores/subscriptions')
    const store = useSubscriptionsStore()

    await store.load(true)
    expect(mockApi.getSubscriptions).toHaveBeenCalledWith(true)
    expect(store.personalSetup).toEqual(personalSetup)

    store.$reset()
    expect(store.personalSetup).toBeNull()
  })

  it('treats a missing field as unknown metadata without creating anything', async () => {
    mockApi.getSubscriptions.mockResolvedValueOnce({ subscriptions: [], count: 0 })
    const { useSubscriptionsStore } = await import('@/stores/subscriptions')
    const store = useSubscriptionsStore()

    await store.load()
    expect(store.personalSetup).toBeNull()
    expect(mockApi.getSubscriptions).toHaveBeenCalledTimes(1)
  })
})
