import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import CalendarView from '@/views/Calendar.vue'
import { mountWithContext } from '@/test-utils'
import type { FormattedEvent } from '@/types/api'

const { mockApi } = vi.hoisted(() => {
  const mockApi = {
    getMe: vi.fn(),
    getConfig: vi.fn(),
    getSubscriptions: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    // v2: getViewData replaces getCalendarData
    getViewData: vi.fn(),
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

describe('Calendar View (/view/:token)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading spinner initially', async () => {
    mockApi.getViewData.mockReturnValue(new Promise(() => {})) // never resolves
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/view/test-token',
    })
    expect(wrapper.find('.animate-spin').exists()).toBe(true)
  })

  it('renders FullCalendar after data loads', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: mockEvents,
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/view/test-token',
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="fullcalendar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('2025秋 课表')
  })

  it('shows "链接不存在或已失效" on 404 (token not found)', async () => {
    mockApi.getViewData.mockRejectedValue({
      response: { status: 404, data: { detail: { error: { code: 'NOT_FOUND', message: '链接不存在' } } } },
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/view/bad-token',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('链接不存在或已失效')
    expect(wrapper.find('[data-testid="fullcalendar"]').exists()).toBe(false)
  })

  it('shows "该分享链接未开启网页查看" on 403 FORMAT_NOT_ALLOWED', async () => {
    mockApi.getViewData.mockRejectedValue({
      response: {
        status: 403,
        data: { detail: { error: { code: 'FORMAT_NOT_ALLOWED', message: '该链接不允许此格式' } } },
      },
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/view/no-web-token',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('该分享链接未开启网页查看')
    expect(wrapper.find('[data-testid="fullcalendar"]').exists()).toBe(false)
  })

  it('shows fallback error for network failures', async () => {
    mockApi.getViewData.mockRejectedValue(new Error('Network Error'))
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/view/test-token',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('加载课表数据失败')
  })

  it('calls api.getViewData with correct token from route param', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '2025秋',
      semester_start: '2025-09-01',
      generated_at: new Date().toISOString(),
      events: [],
    })
    await mountWithContext(CalendarView, {
      initialRoute: '/view/my-link-token-123',
    })
    await flushPromises()

    expect(mockApi.getViewData).toHaveBeenCalledWith('my-link-token-123')
  })

  it('shows fallback title when semester is empty', async () => {
    mockApi.getViewData.mockResolvedValue({
      semester: '',
      semester_start: '',
      generated_at: new Date().toISOString(),
      events: [],
    })
    const { wrapper } = await mountWithContext(CalendarView, {
      initialRoute: '/view/test-token',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('课表日历')
  })
})
