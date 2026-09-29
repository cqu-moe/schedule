import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import type { DatesSetArg, EventClickArg, EventInput, EventMountArg } from '@fullcalendar/core'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  PageHeader,
  PageState,
} from '@cqu-moe/ui'
import { Clock, FlaskConical, MapPin, User } from 'lucide-react'
import api from '@/api'
import type { FormattedEvent } from '@/types/api'
import { apiErrorCode, parseApiError } from '@/utils/error'
import { getSemesterWeek } from '@/utils/calendarWeek'
import '@/assets/fullcalendar-theme.css'
import './calendar.css'

// 课程配色只用设计 token（check:design 禁止硬编码颜色），按首次出现顺序循环分配。
const COURSE_COLORS = [
  'var(--link)',
  'var(--success)',
  'var(--warning)',
  'var(--primary)',
  'var(--destructive)',
] as const

interface SelectedEvent {
  title: string
  extendedProps: Record<string, string>
  start: Date | null
  end: Date | null
}

interface CalendarError {
  state: 'error' | 'forbidden' | 'not-found'
  message: string
}

function toCalendarEvent(event: FormattedEvent, color: string): EventInput {
  return {
    title: event.name,
    start: event.start_time,
    end: event.end_time,
    extendedProps: {
      location: event.location,
      instructor: event.instructor ?? '',
      type: event.type,
      color,
      experimentName: event.experiment_name ?? '',
    },
  }
}

function formatEventTime(event: SelectedEvent | null): string {
  if (!event?.start) return ''
  const fmt = (d: Date) =>
    d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
  const start = fmt(event.start)
  if (!event.end) return start
  if (event.start.toDateString() === event.end.toDateString()) {
    const endTime = event.end.toLocaleString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })
    return `${start} - ${endTime}`
  }
  return `${start} - ${fmt(event.end)}`
}

export default function Calendar() {
  const { token = '' } = useParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<CalendarError | null>(null)
  const [semester, setSemester] = useState('')
  const [semesterStart, setSemesterStart] = useState('')
  const [events, setEvents] = useState<EventInput[]>([])
  const [showDetail, setShowDetail] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<SelectedEvent | null>(null)
  const [initialView] = useState(() =>
    window.innerWidth < 768 ? 'timeGridDay' : 'timeGridWeek',
  )

  const semesterStartRef = useRef('')
  semesterStartRef.current = semesterStart
  const courseColors = useRef(new Map<string, string>())

  function getCourseColor(name: string): string {
    const existing = courseColors.current.get(name)
    if (existing) return existing
    const color = COURSE_COLORS[courseColors.current.size % COURSE_COLORS.length]
    courseColors.current.set(name, color)
    return color
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const data = await api.getViewData(token)
        if (cancelled) return
        setSemester(data.semester)
        setSemesterStart(data.semester_start ?? '')
        setEvents(
          data.events.map((event) =>
            toCalendarEvent(
              event,
              event.type === 'exam' ? 'var(--destructive)' : getCourseColor(event.name),
            ),
          ),
        )
      } catch (cause) {
        if (cancelled) return
        const code = apiErrorCode(cause)
        if (code === 'FORMAT_NOT_ALLOWED') {
          setError({ state: 'forbidden', message: '该分享链接未开启网页查看' })
        } else if (
          code === 'NOT_FOUND' ||
          (cause as { response?: { status?: number } })?.response?.status === 404
        ) {
          setError({ state: 'not-found', message: '链接不存在或已失效' })
        } else {
          setError({ state: 'error', message: parseApiError(cause, '加载课表数据失败') })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  function handleEventMount(info: EventMountArg) {
    const { el } = info
    const color = info.event.extendedProps.color as string
    const type = info.event.extendedProps.type as string
    const location = info.event.extendedProps.location as string
    el.style.setProperty('--event-color', color)
    if (type === 'exam') el.setAttribute('data-event-type', 'exam')
    // 仅在 timegrid（日/周视图）事件标题下附加地点。
    const isTimegrid = el.closest('.fc-timegrid') !== null
    const mainEl = el.querySelector('.fc-event-title')
    if (isTimegrid && mainEl && location) {
      const locDiv = document.createElement('div')
      locDiv.className = 'cal-event-location'
      locDiv.textContent = location
      mainEl.after(locDiv)
    }
  }

  function handleDatesSet(arg: DatesSetArg) {
    if (arg.view.type === 'dayGridMonth') return
    const week = getSemesterWeek(arg.start, semesterStartRef.current)
    requestAnimationFrame(() => {
      const titleEl = document.querySelector('.fc-toolbar-title')
      if (!titleEl) return
      titleEl.querySelector('.semester-week')?.remove()
      if (week !== null) {
        const span = document.createElement('span')
        span.className = 'semester-week'
        span.textContent = `· 第${week}周`
        titleEl.appendChild(span)
      }
    })
  }

  function handleEventClick(info: EventClickArg) {
    setSelectedEvent({
      title: info.event.title,
      extendedProps: info.event.extendedProps as Record<string, string>,
      start: info.event.start,
      end: info.event.end,
    })
    setShowDetail(true)
  }

  const title = semester ? `${semester} 课表` : '课表日历'
  const errorTitle =
    error?.state === 'not-found' ? '链接不存在' : error?.state === 'forbidden' ? '无法查看该课表' : '加载失败'

  return (
    <>
      <PageHeader title={title} description="通过分享链接查看的公开课表。" />
      {loading ? (
        <PageState state="loading" title="正在加载课表" description="正在获取分享的课表数据，请稍候。" />
      ) : error ? (
        <PageState
          state={error.state}
          title={errorTitle}
          description={error.message}
          action={
            <Button asChild variant="outline">
              <Link to="/">返回首页</Link>
            </Button>
          }
        />
      ) : (
        <div className="cal-calendar">
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin]}
            initialView={initialView}
            locale={zhCnLocale}
            timeZone="Asia/Chongqing"
            firstDay={1}
            slotMinTime="08:00:00"
            slotMaxTime="22:00:00"
            slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
            eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
            allDaySlot={false}
            nowIndicator
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: 'timeGridDay,timeGridWeek,dayGridMonth',
            }}
            buttonText={{ today: '今天', day: '日', week: '周', month: '月' }}
            events={events}
            weekNumbers
            weekNumberContent={(arg) => {
              const week = getSemesterWeek(arg.date, semesterStartRef.current)
              return week !== null
                ? { html: `<span class="cal-week-num">W${week}</span>` }
                : { html: '' }
            }}
            datesSet={handleDatesSet}
            eventClick={handleEventClick}
            eventDidMount={handleEventMount}
            height="auto"
          />
        </div>
      )}

      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedEvent?.title}</DialogTitle>
            <DialogDescription>这条日程的详细信息如下。</DialogDescription>
          </DialogHeader>
          <div className="cal-detail">
            {selectedEvent?.extendedProps.instructor && (
              <p className="cal-detail-row">
                <User aria-hidden />
                {selectedEvent.extendedProps.instructor}
              </p>
            )}
            {selectedEvent?.extendedProps.location && (
              <p className="cal-detail-row">
                <MapPin aria-hidden />
                {selectedEvent.extendedProps.location}
              </p>
            )}
            {selectedEvent?.extendedProps.experimentName && (
              <p className="cal-detail-row">
                <FlaskConical aria-hidden />
                {selectedEvent.extendedProps.experimentName}
              </p>
            )}
            <p className="cal-detail-row">
              <Clock aria-hidden />
              {formatEventTime(selectedEvent)}
            </p>
            <span
              className={
                selectedEvent?.extendedProps.type === 'exam'
                  ? 'cal-badge cal-badge-exam'
                  : 'cal-badge cal-badge-course'
              }
            >
              {selectedEvent?.extendedProps.type === 'exam' ? '考试' : '课程'}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
