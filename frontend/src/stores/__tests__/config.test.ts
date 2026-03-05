import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createMockApi } from '@/test-utils'

const mockApi = createMockApi()

vi.mock('@/api', () => ({ default: mockApi }))

describe('config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Reset relevant mocks
    mockApi.getConfig.mockReset()
  })

  it('defaults publicUrl to window.location.origin', async () => {
    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    expect(store.publicUrl).toBe(window.location.origin)
    expect(store.loaded).toBe(false)
  })

  it('load() fetches and sets publicUrl', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    await store.load()

    expect(mockApi.getConfig).toHaveBeenCalledOnce()
    expect(store.publicUrl).toBe('https://schedule.cqu.moe')
    expect(store.loaded).toBe(true)
  })

  it('load() keeps default publicUrl on error', async () => {
    mockApi.getConfig.mockRejectedValue(new Error('Network error'))

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()
    const originalUrl = store.publicUrl

    await store.load()

    expect(store.publicUrl).toBe(originalUrl)
    expect(store.loaded).toBe(true)
  })

  it('load() only calls API once', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    await store.load()
    await store.load()
    await store.load()

    expect(mockApi.getConfig).toHaveBeenCalledOnce()
  })
})
