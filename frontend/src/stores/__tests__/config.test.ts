import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockApi = vi.hoisted(() => ({
  getMe: vi.fn(),
  getConfig: vi.fn(),
  getSubscriptions: vi.fn(),
  getSubscription: vi.fn(),
  createSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  refreshSubscription: vi.fn(),
  getLinks: vi.fn(),
  createLink: vi.fn(),
  patchLink: vi.fn(),
  deleteLink: vi.fn(),
  rotateLink: vi.fn(),
  searchExternal: vi.fn(),
  getDepartments: vi.fn(),
  getViewData: vi.fn(),
}))

vi.mock('@/api', () => ({ default: mockApi }))

describe('config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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

  it('load() keeps default publicUrl on error and still marks loaded', async () => {
    mockApi.getConfig.mockRejectedValue(new Error('Network error'))

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()
    const originalUrl = store.publicUrl

    await store.load()

    expect(store.publicUrl).toBe(originalUrl)
    expect(store.loaded).toBe(true)
  })

  it('load() only calls API once when already loaded', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    await store.load()
    await store.load()
    await store.load()

    expect(mockApi.getConfig).toHaveBeenCalledOnce()
    expect(store.loaded).toBe(true)
  })

  it('$reset() clears loaded and restores publicUrl to origin', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    await store.load()
    expect(store.loaded).toBe(true)

    store.$reset()
    expect(store.loaded).toBe(false)
    expect(store.publicUrl).toBe(window.location.origin)
  })
})
