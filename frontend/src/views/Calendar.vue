<template>
  <div class="min-h-screen bg-background">
    <Navbar />

    <div class="max-w-5xl mx-auto px-4 pt-24 pb-12">
      <!-- Loading state -->
      <div v-if="loading" class="flex items-center justify-center py-20">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="text-center py-20">
        <p class="text-muted-foreground mb-4">{{ error }}</p>
        <router-link :to="{ name: RouteNames.Home }">
          <Button variant="outline" class="cursor-pointer">返回首页</Button>
        </router-link>
      </div>

      <!-- Calendar -->
      <div v-else>
        <div class="mb-4">
          <h2 class="text-lg font-semibold">{{ semester || '课表日历' }}</h2>
        </div>
        <FullCalendar :options="calendarOptions" />
      </div>
    </div>

    <!-- Event detail dialog -->
    <Dialog v-model:open="showDetail">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ selectedEvent?.title }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-2 text-sm">
          <div v-if="selectedEvent?.extendedProps?.instructor" class="flex items-center gap-2">
            <User class="h-4 w-4 text-muted-foreground" />
            <span>{{ selectedEvent.extendedProps.instructor }}</span>
          </div>
          <div v-if="selectedEvent?.extendedProps?.location" class="flex items-center gap-2">
            <MapPin class="h-4 w-4 text-muted-foreground" />
            <span>{{ selectedEvent.extendedProps.location }}</span>
          </div>
          <div v-if="selectedEvent?.extendedProps?.experimentName" class="flex items-start gap-2">
            <FlaskConical class="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <span>{{ selectedEvent.extendedProps.experimentName }}</span>
          </div>
          <div class="flex items-center gap-2">
            <Clock class="h-4 w-4 text-muted-foreground" />
            <span>{{ formatEventTime(selectedEvent) }}</span>
          </div>
          <div>
            <Badge :variant="selectedEvent?.extendedProps?.type === 'exam' ? 'destructive' : 'secondary'">
              {{ selectedEvent?.extendedProps?.type === 'exam' ? '考试' : '课程' }}
            </Badge>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Loader2, User, MapPin, Clock, FlaskConical } from 'lucide-vue-next'
import FullCalendar from '@fullcalendar/vue3'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import type { CalendarOptions, EventClickArg, EventInput, EventMountArg } from '@fullcalendar/core'
import type { FormattedEvent } from '@/types/api'
import { RouteNames } from '@/router'
import api from '@/api'
import { parseApiError } from '@/utils/error'
import Navbar from '@/components/Navbar.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import '@/assets/fullcalendar-theme.css'
import { getSemesterWeek } from '@/utils/calendarWeek'

const COURSE_COLORS = [
  '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
  '#ec4899', '#6366f1', '#14b8a6', '#f97316', '#a855f7',
  '#84cc16', '#e11d48', '#0891b2', '#ea580c', '#2563eb',
]

const courseColorMap = new Map<string, string>()

function getCourseColor(name: string): string {
  const existing = courseColorMap.get(name)
  if (existing) return existing
  const color = COURSE_COLORS[courseColorMap.size % COURSE_COLORS.length]
  courseColorMap.set(name, color)
  return color
}

interface SelectedEvent {
  title: string
  extendedProps: Record<string, string>
  start: Date | null
  end: Date | null
}

const route = useRoute()

const loading = ref(true)
const error = ref<string | null>(null)
const semester = ref('')
const semesterStart = ref('')
const events = ref<EventInput[]>([])
const showDetail = ref(false)
const selectedEvent = ref<SelectedEvent | null>(null)

function toCalendarEvent(e: FormattedEvent): EventInput {
  const color = e.type === 'exam' ? '#ef4444' : getCourseColor(e.name)
  return {
    title: e.name,
    start: e.start_time,
    end: e.end_time,
    extendedProps: {
      location: e.location,
      instructor: e.instructor ?? '',
      type: e.type,
      color,
      experimentName: e.experiment_name ?? '',
    },
  }
}

function handleEventMount(info: EventMountArg) {
  const color = info.event.extendedProps.color as string
  const type = info.event.extendedProps.type as string
  const location = info.event.extendedProps.location as string
  const el = info.el

  // Set CSS custom property for per-event coloring
  el.style.setProperty('--event-color', color)

  // Data attribute for exam-specific CSS
  if (type === 'exam') {
    el.setAttribute('data-event-type', 'exam')
  }

  // Append location info only in timegrid (day/week) views
  const isTimegrid = el.closest('.fc-timegrid') !== null
  const mainEl = el.querySelector('.fc-event-title')
  if (isTimegrid && mainEl && location) {
    const locDiv = document.createElement('div')
    locDiv.style.cssText = 'font-size:0.625rem;opacity:0.6;margin-top:1px;font-weight:400;'
    locDiv.textContent = location
    mainEl.after(locDiv)
  }
}

function handleEventClick(info: EventClickArg) {
  selectedEvent.value = {
    title: info.event.title,
    extendedProps: info.event.extendedProps as Record<string, string>,
    start: info.event.start,
    end: info.event.end,
  }
  showDetail.value = true
}

function formatEventTime(event: typeof selectedEvent.value): string {
  if (!event?.start) return ''
  const fmt = (d: Date) => d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC',
  })
  const start = fmt(event.start)
  if (!event.end) return start
  if (event.start.toDateString() === event.end.toDateString()) {
    const endTime = event.end.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    return `${start} - ${endTime}`
  }
  return `${start} - ${fmt(event.end)}`
}

function handleDatesSet(arg: { view: { type: string }; start: Date; end: Date }) {
  const viewType = arg.view.type
  if (viewType === 'dayGridMonth') return

  const refDate = arg.start

  const week = getSemesterWeek(refDate, semesterStart.value)

  requestAnimationFrame(() => {
    const titleEl = document.querySelector('.fc-toolbar-title')
    if (!titleEl) return

    const existing = titleEl.querySelector('.semester-week')
    if (existing) existing.remove()

    if (week !== null) {
      const span = document.createElement('span')
      span.className = 'semester-week text-muted-foreground font-normal'
      span.style.cssText = 'font-size:0.75em;margin-left:0.5em;'
      span.textContent = `· 第${week}周`
      titleEl.appendChild(span)
    }
  })
}

const calendarOptions = computed<CalendarOptions>(() => ({
  plugins: [dayGridPlugin, timeGridPlugin],
  initialView: window.innerWidth < 768 ? 'timeGridDay' : 'timeGridWeek',
  locale: 'zh-cn',
  timeZone: 'Asia/Chongqing',
  firstDay: 1,
  slotMinTime: '08:00:00',
  slotMaxTime: '22:00:00',
  slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
  eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
  allDaySlot: false,
  nowIndicator: true,
  headerToolbar: {
    left: 'prev,next today',
    center: 'title',
    right: 'timeGridDay,timeGridWeek,dayGridMonth',
  },
  buttonText: {
    today: '今天',
    day: '日',
    week: '周',
    month: '月',
  },
  events: events.value,
  weekNumbers: true,
  weekNumberContent: (arg: { num: number; date: Date }) => {
    const week = getSemesterWeek(arg.date, semesterStart.value)
    return week !== null ? { html: `<span class="text-xs text-muted-foreground">W${week}</span>` } : { html: '' }
  },
  datesSet: handleDatesSet,
  eventClick: handleEventClick,
  eventDidMount: handleEventMount,
  height: 'auto',
}))

onMounted(async () => {
  const subToken = route.params.sub_token as string
  try {
    const data = await api.getCalendarData(subToken)
    semester.value = data.semester ? `${data.semester} 课表` : '课表日历'
    semesterStart.value = data.semester_start ?? ''
    events.value = data.events.map(toCalendarEvent)
  } catch (err) {
    error.value = parseApiError(err, '加载课表数据失败')
  } finally {
    loading.value = false
  }
})
</script>
