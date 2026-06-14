import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'

// RotateTokenDialog is now a per-link rotation confirm component (AlertDialog-based).
// It emits 'confirm' when the user confirms rotation, and 'update:open' to close.

vi.mock('@/api', () => ({
  default: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], count: 0 }),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
}))

const { default: RotateTokenDialog } = await import('@/components/RotateTokenDialog.vue')

describe('RotateTokenDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows rotation confirm content when open', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      props: { open: true },
    })
    expect(wrapper.text()).toContain('确认轮换链接 Token')
    expect(wrapper.text()).toContain('轮换后旧链接立即失效')
  })

  it('shows content regardless of open prop (AlertDialog stub always renders slot)', async () => {
    // Note: the global AlertDialog stub always renders its slot for simplicity.
    // The real AlertDialog gates visibility via open prop; behavior tested via open=true cases.
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      props: { open: false },
    })
    // Stub always renders — content visible in DOM
    expect(wrapper.text()).toContain('确认轮换链接 Token')
  })

  it('emits confirm when "轮换" action button is clicked', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      props: { open: true },
    })
    const confirmBtn = wrapper.findAll('button').find(b => b.text().trim() === '轮换')
    expect(confirmBtn).toBeDefined()
    await confirmBtn!.trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('emits update:open false when "取消" is clicked', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      props: { open: true },
    })
    const cancelBtn = wrapper.findAll('button').find(b => b.text().trim() === '取消')
    expect(cancelBtn).toBeDefined()
    await cancelBtn!.trigger('click')
    const emitted = wrapper.emitted('update:open')
    expect(emitted).toBeDefined()
    expect(emitted![0]).toEqual([false])
  })
})
