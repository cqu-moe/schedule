import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import Calendar from '@/views/Calendar'
import { renderWithApp } from '@/test-utils'
import type { CalendarData } from '@/types/api'

const { mockApi } = vi.hoisted(() => ({ mockApi: { getViewData: vi.fn() } }))
vi.mock('@/api', () => ({ default: mockApi, redirect: { fn: vi.fn() } }))
vi.mock('@fullcalendar/react', async () => vi.importActual('@fullcalendar/react'))
vi.mock('@fullcalendar/daygrid', async () => vi.importActual('@fullcalendar/daygrid'))
vi.mock('@fullcalendar/timegrid', async () => vi.importActual('@fullcalendar/timegrid'))

const HOUR = 60 * 60 * 1000

function schedule(location = '旧教室 D1234'): CalendarData {
  return {
    semester: '2026秋', semester_start: '2026-09-07', generated_at: new Date().toISOString(),
    events: [{
      name: '测试课程', type: 'course', instructor: '测试教师', location,
      day_of_week: 1, week: 9,
      start_time: '2026-11-02T10:00:00+08:00', end_time: '2026-11-02T11:40:00+08:00',
    }],
  }
}

async function openCalendar() {
  await act(async () => {
    renderWithApp(
      <Routes><Route path="/view/:token" element={<Calendar />} /></Routes>,
      { routerEntries: ['/view/refresh-fixture'] },
    )
  })
  expect(screen.getByText('旧教室 D1234')).toBeInTheDocument()
}

async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

describe('Calendar silent refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-02T04:00:00Z'))
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    mockApi.getViewData.mockReset().mockResolvedValue(schedule())
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each(['visibilitychange', 'pageshow'])(
    'refreshes a restored page on %s, without remounting the calendar', async trigger => {
      await openCalendar()
      const calendar = document.querySelector('.fc')
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      visibility.mockReturnValue('hidden')
      fireEvent(document, new Event('visibilitychange'))
      await advance(23 * HOUR)
      expect(mockApi.getViewData).toHaveBeenCalledTimes(1)

      let finishUpdate!: (data: CalendarData) => void
      mockApi.getViewData.mockReturnValue(new Promise<CalendarData>(resolve => { finishUpdate = resolve }))
      visibility.mockReturnValue('visible')
      await act(async () => {
        if (trigger === 'visibilitychange') fireEvent(document, new Event(trigger))
        else fireEvent(window, new PageTransitionEvent(trigger, { persisted: true }))
        fireEvent(window, new Event('online'))
        fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
      })
      expect(mockApi.getViewData).toHaveBeenCalledTimes(2)
      expect(screen.getByText('旧教室 D1234')).toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      await act(async () => { finishUpdate(schedule('新教室 A5678')) })
      expect(screen.getByText('新教室 A5678')).toBeInTheDocument()
      expect(document.querySelector('.fc')).toBe(calendar)
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      fireEvent(document, new Event('visibilitychange'))
      fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
      fireEvent(window, new Event('online'))
      expect(mockApi.getViewData).toHaveBeenCalledTimes(2)
    },
  )

  it('checks at six-hour intervals while visible and preserves the selected view and date', async () => {
    await openCalendar()
    fireEvent.click(screen.getByRole('button', { name: '月' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    const title = document.querySelector('.fc-toolbar-title')?.textContent
    const calendar = document.querySelector('.fc')
    mockApi.getViewData.mockResolvedValue(schedule('新教室 A5678'))
    await advance(6 * HOUR - 1)
    fireEvent(document, new Event('visibilitychange'))
    expect(mockApi.getViewData).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(mockApi.getViewData).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.fc')).toBe(calendar)
    expect(document.querySelector('.fc-toolbar-title')?.textContent).toBe(title)
    expect(document.querySelector('.fc-dayGridMonth-view')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    fireEvent.click(screen.getByRole('button', { name: '周' }))
    fireEvent.click(screen.getByRole('button', { name: '今天' }))
    expect(screen.getByText('新教室 A5678')).toBeInTheDocument()
  })

  it('keeps content unchanged when only the response timestamp changes', async () => {
    await openCalendar()
    const event = document.querySelector('.fc-event')
    const animate = vi.fn()
    document.querySelector<HTMLElement>('.cal-calendar')!.animate = animate
    mockApi.getViewData.mockResolvedValue({ ...schedule(), generated_at: '2026-11-02T10:00:00Z' })
    await advance(6 * HOUR)
    expect(mockApi.getViewData).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.fc-event')).toBe(event)
    expect(animate).not.toHaveBeenCalled()
  })

  it('retains the displayed schedule silently on network failure and avoids rapid retries', async () => {
    await openCalendar()
    mockApi.getViewData.mockRejectedValueOnce(new Error('Network Error'))
    await advance(6 * HOUR)
    expect(screen.getByText('旧教室 D1234')).toBeInTheDocument()
    expect(screen.queryByText('加载课表数据失败')).not.toBeInTheDocument()
    fireEvent(window, new Event('online'))
    fireEvent(document, new Event('visibilitychange'))
    expect(mockApi.getViewData).toHaveBeenCalledTimes(2)
    mockApi.getViewData.mockResolvedValue(schedule('新教室 A5678'))
    await advance(6 * HOUR)
    expect(screen.getByText('新教室 A5678')).toBeInTheDocument()
  })

  it('honors reduced motion after an earlier animated refresh', async () => {
    await openCalendar()
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation)
    document.querySelector<HTMLElement>('.cal-calendar')!.animate = animate
    mockApi.getViewData.mockResolvedValue(schedule('新教室 A5678'))
    await advance(6 * HOUR)
    expect(animate).toHaveBeenCalledTimes(2)
    vi.mocked(window.matchMedia).mockImplementation(query => ({
      matches: query === '(prefers-reduced-motion: reduce)', media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
    }))
    mockApi.getViewData.mockResolvedValue(schedule('再次调课 B9012'))
    await advance(6 * HOUR)
    expect(screen.getByText('再次调课 B9012')).toBeInTheDocument()
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('stops exposing a revoked schedule, including an open event dialog', async () => {
    await openCalendar()
    fireEvent.click(screen.getByText('测试课程'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    mockApi.getViewData.mockRejectedValue({ response: { status: 403 } })
    await advance(6 * HOUR)
    expect(screen.getByText('没有权限查看该课表')).toBeInTheDocument()
    expect(screen.queryByText('旧教室 D1234')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('removes scheduled checks and restore listeners when the page is unmounted', async () => {
    await openCalendar()
    cleanup()
    await advance(24 * HOUR)
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
    fireEvent(window, new Event('online'))
    expect(mockApi.getViewData).toHaveBeenCalledTimes(1)
  })
})
