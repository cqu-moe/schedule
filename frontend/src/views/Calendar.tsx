import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import type {
  CalendarApi,
  DatesSetArg,
  EventClickArg,
  EventInput,
  EventMountArg,
} from '@fullcalendar/core'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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

const CALENDAR_PLUGINS = [dayGridPlugin, timeGridPlugin]
const CALENDAR_HEADER_TOOLBAR = {
  left: 'prev,next today',
  center: 'title',
  right: 'timeGridDay,timeGridWeek,dayGridMonth',
} as const
const CALENDAR_BUTTON_TEXT = { today: '今天', day: '日', week: '周', month: '月' } as const
const CALENDAR_BUTTON_HINTS = {
  prev: '上一页',
  next: '下一页',
  today: '回到今天',
  day: '切换到日视图',
  week: '切换到周视图',
  month: '切换到月视图',
} as const
const CALENDAR_SLOT_LABEL_FORMAT = { hour: '2-digit', minute: '2-digit', hour12: false } as const
const CALENDAR_EVENT_TIME_FORMAT = { hour: '2-digit', minute: '2-digit', hour12: false } as const
const CALENDAR_TIME_ZONE = 'Asia/Chongqing'
const eventDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})
const eventDayFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'UTC',
})
const eventTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

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
  const start = eventDateTimeFormatter.format(event.start)
  if (!event.end) return start
  if (eventDayFormatter.format(event.start) === eventDayFormatter.format(event.end)) {
    return `${start} - ${eventTimeFormatter.format(event.end)}`
  }
  return `${start} - ${eventDateTimeFormatter.format(event.end)}`
}

export default function Calendar() {
  const { token = '' } = useParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<CalendarError | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [semester, setSemester] = useState('')
  const [semesterStart, setSemesterStart] = useState('')
  const [events, setEvents] = useState<EventInput[]>([])
  const [currentWeek, setCurrentWeek] = useState<number | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<SelectedEvent | null>(null)
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => window.matchMedia('(max-width: 767px)').matches,
  )

  const semesterStartRef = useRef('')
  semesterStartRef.current = semesterStart
  const courseColors = useRef(new Map<string, string>())
  const calendarApiRef = useRef<CalendarApi | null>(null)
  const activeEventElRef = useRef<HTMLElement | null>(null)

  function getCourseColor(name: string): string {
    const existing = courseColors.current.get(name)
    if (existing) return existing
    const color = COURSE_COLORS[courseColors.current.size % COURSE_COLORS.length]
    courseColors.current.set(name, color)
    return color
  }

  const retry = useCallback(() => setReloadNonce((nonce) => nonce + 1), [])

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
        const status = (cause as { response?: { status?: number } })?.response?.status
        if (code === 'FORMAT_NOT_ALLOWED') {
          setError({ state: 'forbidden', message: '该分享链接未开启网页查看' })
        } else if (status === 403) {
          setError({ state: 'forbidden', message: '没有权限查看该课表' })
        } else if (
          code === 'NOT_FOUND' ||
          status === 404
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
  }, [token, reloadNonce])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const syncViewport = () => setIsMobileViewport(query.matches)
    query.addEventListener('change', syncViewport)
    return () => query.removeEventListener('change', syncViewport)
  }, [])

  useEffect(() => {
    calendarApiRef.current?.changeView(isMobileViewport ? 'timeGridDay' : 'timeGridWeek')
  }, [isMobileViewport])

  const handleEventMount = useCallback((info: EventMountArg) => {
    const { el } = info
    const color = info.event.extendedProps.color as string
    const type = info.event.extendedProps.type as string
    const location = info.event.extendedProps.location as string
    el.style.setProperty('--event-color', color)
    el.setAttribute('role', 'button')
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
  }, [])

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    setCurrentWeek(getSemesterWeek(arg.view.calendar.getDate(), semesterStartRef.current))
  }, [])

  const handleEventClick = useCallback((info: EventClickArg) => {
    activeEventElRef.current = info.el
    setSelectedEvent({
      title: info.event.title,
      extendedProps: info.event.extendedProps as Record<string, string>,
      start: info.event.start,
      end: info.event.end,
    })
    setShowDetail(true)
  }, [])

  const handleDialogCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
    activeEventElRef.current?.focus()
    activeEventElRef.current = null
  }, [])

  const initialView = isMobileViewport ? 'timeGridDay' : 'timeGridWeek'
  const calendar = useMemo(
    () => (
      <FullCalendar
        ref={(instance) => {
          calendarApiRef.current = instance?.getApi() ?? null
        }}
        plugins={CALENDAR_PLUGINS}
        initialView={initialView}
        locale={zhCnLocale}
        timeZone={CALENDAR_TIME_ZONE}
        firstDay={1}
        slotMinTime="08:00:00"
        slotMaxTime="22:00:00"
        slotLabelFormat={CALENDAR_SLOT_LABEL_FORMAT}
        eventTimeFormat={CALENDAR_EVENT_TIME_FORMAT}
        allDaySlot={false}
        nowIndicator
        headerToolbar={CALENDAR_HEADER_TOOLBAR}
        buttonText={CALENDAR_BUTTON_TEXT}
        buttonHints={CALENDAR_BUTTON_HINTS}
        events={events}
        weekNumbers
        weekNumberContent={(arg) => {
          const week = getSemesterWeek(arg.date, semesterStartRef.current)
          return week !== null ? `W${week}` : ''
        }}
        datesSet={handleDatesSet}
        eventClick={handleEventClick}
        eventDidMount={handleEventMount}
        eventInteractive
        height="auto"
      />
    ),
    [
      events,
      handleDatesSet,
      handleEventClick,
      handleEventMount,
      initialView,
    ],
  )

  const teachingWeekLabel = currentWeek === null ? '当前日期不在教学周内' : `第${currentWeek}教学周`
  const pageDescription = loading
    ? '正在获取学期与教学周信息。'
    : error
      ? '暂时无法确认学期与教学周信息。'
      : `${semester || '未知学期'} · ${teachingWeekLabel}`
  const errorTitle =
    error?.state === 'not-found' ? '链接不存在' : error?.state === 'forbidden' ? '无法查看该课表' : '加载失败'

  return (
    <>
      <header className="cal-heading">
        <h1>课表日历</h1>
        <p>{pageDescription}</p>
      </header>
      {loading ? (
        <PageState state="loading" title="正在加载课表" description="正在获取分享的课表数据，请稍候。" />
      ) : error ? (
        <PageState
          state={error.state}
          title={errorTitle}
          description={error.message}
          action={
            error.state === 'error' ? (
              <Button onClick={retry}>重试加载</Button>
            ) : (
              <Button asChild variant="outline">
                <Link to="/">返回首页</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="cal-calendar">
          {events.length === 0 && (
            <div className="cal-empty">
              <PageState
                state="empty"
                title="这份课表暂无日程"
                description="仍可切换日期和视图查看其他时间；如认为应有课程，请联系分享者更新课表。"
              />
            </div>
          )}
          {calendar}
        </div>
      )}

      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent onCloseAutoFocus={handleDialogCloseAutoFocus}>
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
