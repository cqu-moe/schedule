import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithApp, mockSubscription } from '@/test-utils'
import type { CalendarLink, Subscription } from '@/types/api'

const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn(), info: vi.fn() }
  const mockApi = {
    createLink: vi.fn(),
    patchLink: vi.fn(),
    deleteLink: vi.fn(),
    rotateLink: vi.fn(),
  }
  return { mockApi, mockToast }
})

vi.mock('@/api', () => ({ default: mockApi, redirect: { fn: vi.fn() } }))
vi.mock('@cqu-moe/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: mockToast,
}))

const { default: ShareLinksDialog } = await import('@/components/ShareLinksDialog')

function makeDefaultLink(overrides: Partial<CalendarLink> = {}): CalendarLink {
  return {
    id: 'link-default',
    token: 'default-token',
    label: null,
    formats: ['ics', 'origin_json', 'data_json', 'csv', 'web'],
    is_default: true,
    ...overrides,
  }
}

function makeShareLink(overrides: Partial<CalendarLink> = {}): CalendarLink {
  return {
    id: 'link-share',
    token: 'share-token',
    label: '同学链接',
    formats: ['ics', 'web'],
    is_default: false,
    ...overrides,
  }
}

function mountDialog(links: CalendarLink[] = [makeDefaultLink()]) {
  const sub: Subscription = mockSubscription({ links })
  const onChanged = vi.fn()
  renderWithApp(
    <ShareLinksDialog
      open
      subscription={sub}
      shareLinkCount={links.filter((l) => !l.is_default).length}
      atShareLimit={false}
      onOpenChange={() => {}}
      onChanged={onChanged}
    />,
  )
  return { sub, onChanged }
}

describe('ShareLinksDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders title, subscription name and default link', async () => {
    mountDialog()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('管理共享链接')).toBeInTheDocument()
    expect(within(dialog).getByText(/我的课表/)).toBeInTheDocument()
    expect(within(dialog).getByText('默认链接')).toBeInTheDocument()
    expect(within(dialog).getByText('默认')).toBeInTheDocument()
    expect(within(dialog).getByText('共享链接 0 / 无限')).toBeInTheDocument()
  })

  it('copies the ICS URL for an available format', async () => {
    mountDialog([makeDefaultLink({ formats: ['ics', 'web'] })])
    const button = await screen.findByRole('button', { name: '复制 日历订阅 (ICS)' })
    await userEvent.click(button)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://schedule.cqu.moe/api/v2/calendar/default-token/calendar.ics',
    )
  })

  it('creates a share link with label and selected formats', async () => {
    const { onChanged } = mountDialog()
    mockApi.createLink.mockResolvedValue({
      id: 'link-new',
      token: 'new-token',
      label: '同学链接',
      formats: ['ics'],
      is_default: false,
    })
    await userEvent.click(await screen.findByRole('button', { name: '新建共享链接' }))

    const form = await screen.findByRole('dialog', { name: '新建共享链接' })
    await userEvent.type(
      within(form).getByLabelText('标签（可选，最多 100 字符）'),
      '同学链接',
    )
    await userEvent.click(within(form).getByRole('button', { name: '日历网页查看' }))
    await userEvent.click(within(form).getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(mockApi.createLink).toHaveBeenCalledWith('sub-1', {
        label: '同学链接',
        formats: ['ics'],
      })
      expect(mockToast.success).toHaveBeenCalledWith('共享链接已创建')
    })
    expect(onChanged).toHaveBeenCalled()
    expect(await screen.findByText('同学链接')).toBeInTheDocument()
  })

  it('rotates a link after confirmation and reports the new token', async () => {
    mockApi.rotateLink.mockResolvedValue({ token: 'rotated-token' })
    const { onChanged, sub } = mountDialog([makeDefaultLink(), makeShareLink()])

    const shareRow = (await screen.findByText('同学链接')).closest('tr') as HTMLElement
    await userEvent.click(within(shareRow).getByRole('button', { name: '轮换' }))

    const confirm = await screen.findByRole('dialog', { name: '确认轮换链接 Token' })
    await userEvent.click(within(confirm).getByRole('button', { name: '轮换' }))

    await waitFor(() => {
      expect(mockApi.rotateLink).toHaveBeenCalledWith(sub.id, 'link-share')
      expect(mockToast.success).toHaveBeenCalledWith('已轮换')
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('maps QUOTA_EXCEEDED to an inline form error', async () => {
    mockApi.createLink.mockRejectedValue({
      response: { data: { detail: { error: { code: 'QUOTA_EXCEEDED' } } } },
    })
    mountDialog()
    await userEvent.click(await screen.findByRole('button', { name: '新建共享链接' }))
    const form = await screen.findByRole('dialog', { name: '新建共享链接' })
    await userEvent.click(within(form).getByRole('button', { name: '创建' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('共享链接数量已达上限')
    expect(mockToast.success).not.toHaveBeenCalled()
  })
})
