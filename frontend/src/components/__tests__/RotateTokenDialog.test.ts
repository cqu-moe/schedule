import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'

// TODO(FE-2): this test covers the interim v2 shim of RotateTokenDialog
// (which shows a "feature migrated" message). Rewrite when FE-2 implements
// per-link rotation UI.

vi.mock('@/api', () => ({
  default: {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], count: 0 }),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
}))

const { default: RotateTokenDialog } = await import('@/components/RotateTokenDialog.vue')

describe('RotateTokenDialog (v2 shim)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders trigger slot content', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Rotate</button>',
      },
    })
    expect(wrapper.text()).toContain('Rotate')
  })

  it('shows migration message explaining token rotation moved to per-link', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Open</button>',
      },
    })

    // The dialog content should explain the migration to per-link rotation
    expect(wrapper.text()).toContain('功能已迁移')
    expect(wrapper.text()).toContain('关闭')
  })
})
