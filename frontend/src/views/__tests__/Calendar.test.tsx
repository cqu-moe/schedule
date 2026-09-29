import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import Calendar from '@/views/Calendar'
import { renderWithApp } from '@/test-utils'
import type { FormattedEvent } from '@/types/api'

const { mockApi } = vi.hoisted(() => ({
  mockApi: { getViewData: vi.fn() },
}))

vi.mock('@/api', () => ({ default: mockApi, redirect: { fn: vi.fn() } }))

// 覆盖全局 mock：渲染一个按钮触发 eventClick，用于验证事件详情 Dialog。
vi.mock('@fullcalendar/react', () => ({
  default: function MockFullCalendar(props: Record<string, unknown>) {
    return (
      <div data-testid="fullcalendar">
        <button
          type="button"
          data-testid="fc-open-event"
          onClick={() =>
            (props.eventClick as (arg: unknown) => void)({
              event: {
                title: '高等数学',
                extendedProps: {
                  instructor: '李老师',
                  location: 'D1234',
                  type: 'course',
                  experimentName: '',
                },
                start: new Date('2025-09-01T08:00:00+08:00'),
                end: new Date('2025-09-01T09:40:00+08:00'),
              },
            })
          }
        >
          打开事件详情
        </button>
      </div>
    )
  },
}))

const mockEvents: FormattedEvent[] = [
  {
    name: '高等数学',
    type: 'course',
    instructor: '李老师',
    location: 'D1234',
    day_of_week: 1,
    start_time: '2025-09-01T08:00:00+08:00',
    end_time: '2025-09-01T09:40:00+08:00',
    week: 1,
  },
  {
    name: '期末考试',
    type: 'exam',
    instructor: null,
    location: 'A101 座位5',
    day_of_week: null,
    start_time: '2025-12-20T14:00:00+08:00',
    end_time: '2025-12-20T16:00:00+08:00',
    week: null,
  },
]

function renderCalendar(token: string) {
  return renderWithApp(
    <Routes>
      <Route path="/view/:token" element={<Calendar />} />
    </Routes>,
    { routerEntries: [`/view/${token}`] },
  )
}

describe('Calendar view (/view/:token)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the loading state before data arrives', () => {
    mockApi.getViewData.mockReturnValue(new Promise(() => {}))
    renderCalendar('test-token')
    expect(screen.getByText('正在加载课表')).toBeInTheDocument()
    expect(screen.queryByTestId('fullcalendar')).not.toBeInTheDocument()
  })

  it('renders the calendar and semester title after loading', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: mockEvents,
    })
    renderCalendar('test-token')
    expect(await screen.findByTestId('fullcalendar')).toBeInTheDocument()
    expect(screen.getByText('2025秋 课表')).toBeInTheDocument()
  })

  it('requests the view data with the route token', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: [],
    })
    renderCalendar('my-link-token-123')
    await screen.findByTestId('fullcalendar')
    expect(mockApi.getViewData).toHaveBeenCalledWith('my-link-token-123')
  })

  it('shows an invalid-link error page with a home action on 404', async () => {
    mockApi.getViewData.mockRejectedValue({
      response: { status: 404, data: { detail: { error: { code: 'NOT_FOUND' } } } },
    })
    renderCalendar('bad-token')
    expect(await screen.findByText('链接不存在或已失效')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回首页' })).toBeInTheDocument()
    expect(screen.queryByTestId('fullcalendar')).not.toBeInTheDocument()
  })

  it('explains when the share link disallows web viewing', async () => {
    mockApi.getViewData.mockRejectedValue({
      response: {
        status: 403,
        data: { detail: { error: { code: 'FORMAT_NOT_ALLOWED' } } },
      },
    })
    renderCalendar('no-web-token')
    expect(await screen.findByText('该分享链接未开启网页查看')).toBeInTheDocument()
  })

  it('falls back to a generic error message for network failures', async () => {
    mockApi.getViewData.mockRejectedValue(new Error('Network Error'))
    renderCalendar('test-token')
    expect(await screen.findByText('加载课表数据失败')).toBeInTheDocument()
  })

  it('opens the event detail dialog with course information', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: mockEvents,
    })
    const user = userEvent.setup()
    renderCalendar('test-token')
    await user.click(await screen.findByTestId('fc-open-event'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('高等数学')).toBeInTheDocument()
    expect(within(dialog).getByText('李老师')).toBeInTheDocument()
    expect(within(dialog).getByText('D1234')).toBeInTheDocument()
    expect(within(dialog).getByText('课程')).toBeInTheDocument()
  })

  it('falls back to the generic title when the semester is empty', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '',
      semester_start: '',
      generated_at: new Date().toISOString(),
      events: [],
    })
    renderCalendar('test-token')
    await screen.findByTestId('fullcalendar')
    expect(screen.getByText('课表日历')).toBeInTheDocument()
  })
})
