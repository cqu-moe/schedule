import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import Calendar from '@/views/Calendar'
import { renderWithApp } from '@/test-utils'
import type { FormattedEvent } from '@/types/api'

const { calendarMock, mockApi } = vi.hoisted(() => ({
  calendarMock: {
    props: undefined as Record<string, unknown> | undefined,
    renderCount: 0,
  },
  mockApi: { getViewData: vi.fn() },
}))

vi.mock('@/api', () => ({ default: mockApi, redirect: { fn: vi.fn() } }))

// FullCalendar 无 named-timezone 插件时，EventApi Date 是 UTC-coerced 墙面时间。
vi.mock('@fullcalendar/react', () => ({
  default: function MockFullCalendar(props: Record<string, unknown>) {
    calendarMock.props = props
    calendarMock.renderCount += 1

    useEffect(() => {
      const datesSet = props.datesSet as
        | ((arg: { view: { calendar: { getDate: () => Date } } }) => void)
        | undefined
      datesSet?.({
        view: { calendar: { getDate: () => new Date(2025, 8, 1, 12, 0, 0) } },
      })
    }, [])

    return (
      <div data-testid="fullcalendar" data-event-interactive={String(props.eventInteractive)}>
        <button
          type="button"
          data-testid="fc-open-event"
          onClick={(clickEvent) => {
            const eventClick = props.eventClick as (arg: {
              el: HTMLButtonElement
              event: {
                title: string
                extendedProps: Record<string, string>
                start: Date | null
                end: Date | null
              }
            }) => void
            eventClick({
              el: clickEvent.currentTarget,
              event: {
                title: '高等数学',
                extendedProps: {
                  instructor: '李老师',
                  location: 'D1234',
                  type: 'course',
                  experimentName: '',
                },
                start: new Date('2025-09-01T08:00:00Z'),
                end: new Date('2025-09-01T09:40:00Z'),
              },
            })
          }}
        >
          打开事件详情
        </button>
        <button
          type="button"
          data-testid="fc-open-cross-day-event"
          onClick={(clickEvent) => {
            const eventClick = props.eventClick as (arg: {
              el: HTMLButtonElement
              event: {
                title: string
                extendedProps: Record<string, string>
                start: Date | null
                end: Date | null
              }
            }) => void
            eventClick({
              el: clickEvent.currentTarget,
              event: {
                title: '跨日日程',
                extendedProps: {
                  instructor: '',
                  location: '',
                  type: 'course',
                  experimentName: '',
                },
                start: new Date('2025-09-01T22:00:00Z'),
                end: new Date('2025-09-02T01:00:00Z'),
              },
            })
          }}
        >
          打开跨日详情
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

function resolveCalendarData(events: FormattedEvent[] = mockEvents) {
  return {
    semester: '2025秋',
    semester_start: '2025-09-01',
    generated_at: new Date().toISOString(),
    events,
  }
}

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
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
    vi.clearAllMocks()
    calendarMock.props = undefined
    calendarMock.renderCount = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the page heading and loading state before data arrives', () => {
    mockApi.getViewData.mockReturnValue(new Promise(() => {}))
    renderCalendar('test-token')
    expect(screen.getByRole('heading', { level: 1, name: '课表日历' })).toBeInTheDocument()
    expect(screen.getByText('正在获取学期与教学周信息。')).toBeInTheDocument()
    expect(screen.getByText('正在加载课表')).toBeInTheDocument()
    expect(screen.queryByTestId('fullcalendar')).not.toBeInTheDocument()
  })

  it('renders the semester and teaching week after loading', async () => {
    mockApi.getViewData.mockResolvedValue(resolveCalendarData())
    renderCalendar('test-token')
    expect(await screen.findByTestId('fullcalendar')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '课表日历' })).toBeInTheDocument()
    expect(await screen.findByText('2025秋 · 第1教学周')).toBeInTheDocument()
  })

  it('requests the view data with the route token and enables real keyboard activation', async () => {
    mockApi.getViewData.mockResolvedValue(resolveCalendarData([]))
    renderCalendar('my-link-token-123')
    const calendar = await screen.findByTestId('fullcalendar')
    expect(mockApi.getViewData).toHaveBeenCalledWith('my-link-token-123')
    expect(calendar).toHaveAttribute('data-event-interactive', 'true')
    expect(calendarMock.props?.eventInteractive).toBe(true)
  })

  it('explains an empty schedule while keeping the calendar navigable', async () => {
    mockApi.getViewData.mockResolvedValue(resolveCalendarData([]))
    renderCalendar('empty-token')
    expect(await screen.findByTestId('fullcalendar')).toBeInTheDocument()
    expect(screen.getByText('这份课表暂无日程')).toBeInTheDocument()
    expect(
      screen.getByText('仍可切换日期和视图查看其他时间；如认为应有课程，请联系分享者更新课表。'),
    ).toBeInTheDocument()
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
    expect(screen.getByRole('link', { name: '返回首页' })).toBeInTheDocument()
  })

  it('retries a generic load failure in place', async () => {
    mockApi.getViewData
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce(resolveCalendarData())
    const user = userEvent.setup()
    renderCalendar('test-token')
    expect(await screen.findByText('加载课表数据失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试加载' }))
    expect(await screen.findByTestId('fullcalendar')).toBeInTheDocument()
    expect(mockApi.getViewData).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('加载课表数据失败')).not.toBeInTheDocument()
  })

  it('opens the event dialog with UTC-coerced times and returns focus to the event', async () => {
    mockApi.getViewData.mockResolvedValue(resolveCalendarData())
    const user = userEvent.setup()
    renderCalendar('test-token')
    const eventButton = await screen.findByTestId('fc-open-event')
    await user.click(eventButton)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('高等数学')).toBeInTheDocument()
    expect(within(dialog).getByText('李老师')).toBeInTheDocument()
    expect(within(dialog).getByText('D1234')).toBeInTheDocument()
    expect(within(dialog).getByText('09/01 08:00 - 09:40')).toBeInTheDocument()
    expect(calendarMock.renderCount).toBe(1)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(eventButton).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    expect(await screen.findByText('未知学期 · 当前日期不在教学周内')).toBeInTheDocument()
  })

  it('keeps both dates and times for a cross-day event', async () => {
    mockApi.getViewData.mockResolvedValue(resolveCalendarData())
    const user = userEvent.setup()
    renderCalendar('test-token')
    await user.click(await screen.findByTestId('fc-open-cross-day-event'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('09/01 22:00 - 09/02 01:00')).toBeInTheDocument()
  })

  it('matches FullCalendar React UTC coercion for a named timezone without a plugin', async () => {
    const [
      { default: ActualDayGridPlugin },
      { default: ActualFullCalendar },
      { default: ActualTimeGridPlugin },
    ] =
      await Promise.all([
        vi.importActual<typeof import('@fullcalendar/daygrid')>('@fullcalendar/daygrid'),
        vi.importActual<typeof import('@fullcalendar/react')>('@fullcalendar/react'),
        vi.importActual<typeof import('@fullcalendar/timegrid')>('@fullcalendar/timegrid'),
      ])
    const eventClick = vi.fn()
    const plugins = [ActualDayGridPlugin, ActualTimeGridPlugin]
    expect(plugins.map((plugin) => typeof plugin)).toEqual(['object', 'object'])
    expect(plugins.every((plugin) => Array.isArray(plugin.deps))).toBe(true)

    render(
      <ActualFullCalendar
        plugins={plugins}
        initialView="timeGridDay"
        initialDate="2025-09-01"
        timeZone="Asia/Chongqing"
        events={[
          {
            title: '高等数学',
            start: '2025-09-01T08:00:00+08:00',
            end: '2025-09-01T09:40:00+08:00',
          },
        ]}
        eventClick={eventClick}
        height="auto"
      />,
    )

    await fireEvent.click(await screen.findByText('高等数学'))
    expect(eventClick).toHaveBeenCalledTimes(1)
    const event = eventClick.mock.calls[0][0].event
    // FullCalendar emits the wall time in UTC coordinates; display code must use UTC.
    expect(event.start?.toISOString()).toBe('2025-09-01T08:00:00.000Z')
    expect(event.startStr).toBe('2025-09-01T08:00:00+08:00')
    expect(event.end?.toISOString()).toBe('2025-09-01T09:40:00.000Z')
    expect(event.endStr).toBe('2025-09-01T09:40:00+08:00')
  })
})
