import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import CalendarView from '@/views/Calendar.vue'
import { mountWithContext } from '@/test-utils'
import type { FormattedEvent } from '@/types/api'

const { mockApi } = vi.hoisted(() => {
  const mockApi = {
    register: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getUserInfo: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn(),
    getConfig: vi.fn(),
    getCalendarData: vi.fn(),
  }
  return { mockApi }
})
vi.mock('@/api', () => ({ default: mockApi }))

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

describe('Calendar View', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading spinner initially', async () => {
    mockApi.getCalendarData.mockReturnValue(new Promise(() => {})) // never resolves
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/calendar/test-token',
    })
    expect(wrapper.find('.animate-spin').exists()).toBe(true)
  })

  it('renders FullCalendar after data loads', async () => {
    mockApi.getCalendarData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: mockEvents,
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/calendar/test-token',
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="fullcalendar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('2025秋 课表')
  })

  it('shows error message on API failure', async () => {
    mockApi.getCalendarData.mockRejectedValue({
      response: { status: 404, data: { detail: { error: { code: 'NOT_FOUND', message: '订阅不存在' } } } },
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/calendar/bad-token',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('订阅不存在')
    expect(wrapper.find('[data-testid="fullcalendar"]').exists()).toBe(false)
  })

  it('calls API with correct sub_token from route', async () => {
    mockApi.getCalendarData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: [],
    })
    await mountWithContext(CalendarView, {
      initialRoute: '/calendar/my-sub-token-123',
    })
    await flushPromises()

    expect(mockApi.getCalendarData).toHaveBeenCalledWith('my-sub-token-123')
  })

  it('shows fallback title when semester is empty', async () => {
    mockApi.getCalendarData.mockResolvedValue({
      semester: '',
      semester_start: '',
      generated_at: new Date().toISOString(),
      events: [],
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/calendar/test-token',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('课表日历')
  })
})
