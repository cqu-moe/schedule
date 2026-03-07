import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountWithContext } from '@/test-utils'

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn() }
  const mockApi = {
    register: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getUserInfo: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [], max: 5 }),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
    getCalendarData: vi.fn(),
    rotateTokenPrepare: vi.fn(),
    rotateTokenConfirm: vi.fn(),
    rotateSubscription: vi.fn(),
    rotateAllSubscriptions: vi.fn(),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index', () => ({ default: mockApi }))
vi.mock('vue-sonner', () => ({ toast: mockToast }))

const { default: RotateTokenDialog } = await import('@/components/RotateTokenDialog.vue')

describe('RotateTokenDialog', () => {
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

  it('does not call prepare API before dialog opens', async () => {
    await mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Open</button>',
      },
    })
    expect(mockApi.rotateTokenPrepare).not.toHaveBeenCalled()
  })

  it('shows loading title and cancel button in initial state', async () => {
    // AlertDialog stub always renders its slot, so the loading template
    // (step === 'loading', the default) is visible immediately.
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Open</button>',
      },
    })

    expect(wrapper.text()).toContain('轮换认证 Token')
    expect(wrapper.text()).toContain('取消')
  })

  it('does not show confirm or error content in initial loading state', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Open</button>',
      },
    })

    // Confirm step content should not be visible
    expect(wrapper.text()).not.toContain('确认新 Token')
    expect(wrapper.text()).not.toContain('确认轮换')
    // Error step content should not be visible
    expect(wrapper.text()).not.toContain('轮换失败')
  })

  it('does not show display step content before API call', async () => {
    const { wrapper } = await mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Open</button>',
      },
    })

    // Display step content should not be visible
    expect(wrapper.text()).not.toContain('请妥善保存新 Token')
    expect(wrapper.text()).not.toContain('我已保存，下一步')
  })
})
