# Calendar View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a FullCalendar-based calendar display page at `/calendar/:sub_token` with day/week/month views, fetching data from the existing `data.json` endpoint.

**Architecture:** New Vue view component using `@fullcalendar/vue3` with `timegrid` and `daygrid` plugins. Data fetched via public `data.json` API endpoint (no auth required). Dashboard subscription cards get a "view calendar" button linking to the calendar page.

**Tech Stack:** @fullcalendar/vue3, @fullcalendar/core, @fullcalendar/daygrid, @fullcalendar/timegrid, existing Vue 3 + Tailwind v4 + shadcn-vue stack.

---

### Task 1: Install FullCalendar dependencies

**Files:**
- Modify: `frontend/package.json`

**Step 1: Install packages**

Run:
```bash
cd frontend && npm install @fullcalendar/vue3 @fullcalendar/core @fullcalendar/daygrid @fullcalendar/timegrid
```

**Step 2: Verify installation**

Run:
```bash
cd frontend && node -e "require('@fullcalendar/vue3'); console.log('OK')"
```
Expected: `OK`

**Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: add FullCalendar dependencies"
```

---

### Task 2: Add API method and types for calendar data

**Files:**
- Modify: `frontend/src/types/api.ts` — add `CalendarData` and `FormattedEvent` types
- Modify: `frontend/src/api/index.ts` — add `getCalendarData()` method

**Step 1: Add types to `frontend/src/types/api.ts`**

Append after the `AuthResult` interface:

```typescript
export interface FormattedEvent {
  name: string
  type: 'course' | 'exam'
  instructor: string | null
  location: string
  day_of_week: number | null
  start_time: string
  end_time: string
  week: number | null
}

export interface CalendarData {
  semester: string
  semester_start: string
  generated_at: string
  events: FormattedEvent[]
}
```

**Step 2: Add API method to `frontend/src/api/index.ts`**

Import `CalendarData` in the import block:

```typescript
import type {
  UserInfo,
  SubscriptionList,
  SearchResult,
  AppConfig,
  HealthStatus,
  Subscription,
  CalendarData,
} from '@/types/api'
```

Add method at the end of the default export object (before the closing `}`):

```typescript
  async getCalendarData(subToken: string): Promise<CalendarData> {
    const response = await client.get(`/subscriptions/${subToken}/data.json`)
    return response.data
  },
```

**Step 3: Verify typecheck**

Run:
```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -v tsconfig.node.json || true
```
Expected: No new errors related to api.ts or types/api.ts.

**Step 4: Commit**

```bash
git add frontend/src/types/api.ts frontend/src/api/index.ts
git commit -m "feat: add calendar data API method and types"
```

---

### Task 3: Add FullCalendar theme CSS

**Files:**
- Create: `frontend/src/assets/fullcalendar-theme.css`

**Step 1: Create theme file**

```css
/* FullCalendar theme overrides for shadcn-vue / Tailwind v4 */

/* Base variables */
.fc {
  --fc-border-color: var(--border);
  --fc-button-bg-color: var(--secondary);
  --fc-button-border-color: var(--border);
  --fc-button-text-color: var(--secondary-foreground);
  --fc-button-hover-bg-color: var(--accent);
  --fc-button-hover-border-color: var(--border);
  --fc-button-active-bg-color: var(--primary);
  --fc-button-active-border-color: var(--primary);
  --fc-button-active-text-color: var(--primary-foreground);
  --fc-page-bg-color: var(--background);
  --fc-neutral-bg-color: var(--muted);
  --fc-today-bg-color: color-mix(in srgb, var(--primary) 8%, transparent);
  --fc-event-bg-color: var(--primary);
  --fc-event-border-color: var(--primary);
  --fc-event-text-color: var(--primary-foreground);
  --fc-now-indicator-color: var(--destructive);
}

/* Font consistency */
.fc {
  font-family: inherit;
  font-size: 0.875rem;
}

/* Button styling to match shadcn */
.fc .fc-button {
  border-radius: calc(var(--radius) - 2px);
  font-weight: 500;
  font-size: 0.8125rem;
  padding: 0.375rem 0.75rem;
  box-shadow: none !important;
  transition: background-color 0.15s, color 0.15s;
}

.fc .fc-button:focus {
  box-shadow: 0 0 0 2px var(--ring) !important;
}

/* Today button */
.fc .fc-today-button:disabled {
  opacity: 0.5;
}

/* Toolbar spacing */
.fc .fc-toolbar {
  gap: 0.5rem;
  flex-wrap: wrap;
}

.fc .fc-toolbar-title {
  font-size: 1.125rem;
  font-weight: 600;
}

/* Event styling */
.fc .fc-event {
  border-radius: calc(var(--radius) - 4px);
  border: none;
  padding: 2px 4px;
  font-size: 0.75rem;
  cursor: pointer;
}

.fc .fc-timegrid-event .fc-event-main {
  padding: 2px 4px;
}

/* Time grid slots */
.fc .fc-timegrid-slot {
  height: 2.5rem;
}

/* Day header */
.fc .fc-col-header-cell {
  padding: 0.5rem 0;
  font-weight: 500;
}

/* Scrollbar consistency */
.fc .fc-scroller {
  scrollbar-width: thin;
}
```

**Step 2: Commit**

```bash
git add frontend/src/assets/fullcalendar-theme.css
git commit -m "feat: add FullCalendar theme CSS for shadcn/Tailwind"
```

---

### Task 4: Create Calendar view component

**Files:**
- Create: `frontend/src/views/Calendar.vue`

**Step 1: Create the Calendar view**

```vue
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
        <router-link to="/">
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

    <!-- Event detail popover -->
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
import { Loader2, User, MapPin, Clock } from 'lucide-vue-next'
import FullCalendar from '@fullcalendar/vue3'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import type { CalendarOptions, EventClickArg, EventInput } from '@fullcalendar/core'
import type { FormattedEvent } from '@/types/api'
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
import '@fullcalendar/core/main.css'
import '@/assets/fullcalendar-theme.css'

const route = useRoute()

const loading = ref(true)
const error = ref<string | null>(null)
const semester = ref('')
const events = ref<EventInput[]>([])
const showDetail = ref(false)
const selectedEvent = ref<{ title: string; extendedProps: Record<string, string>; start: Date | null; end: Date | null } | null>(null)

function toCalendarEvent(e: FormattedEvent): EventInput {
  return {
    title: e.name,
    start: e.start_time,
    end: e.end_time,
    extendedProps: {
      location: e.location,
      instructor: e.instructor ?? '',
      type: e.type,
    },
    backgroundColor: e.type === 'exam' ? 'var(--destructive)' : undefined,
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
  })
  const start = fmt(event.start)
  if (!event.end) return start
  // Same day: only show time for end
  if (event.start.toDateString() === event.end.toDateString()) {
    const endTime = event.end.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    return `${start} - ${endTime}`
  }
  return `${start} - ${fmt(event.end)}`
}

const calendarOptions = computed<CalendarOptions>(() => ({
  plugins: [dayGridPlugin, timeGridPlugin],
  initialView: window.innerWidth < 768 ? 'timeGridDay' : 'timeGridWeek',
  locale: 'zh-cn',
  timeZone: 'Asia/Chongqing',
  firstDay: 1,
  slotMinTime: '08:00:00',
  slotMaxTime: '22:00:00',
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
  eventClick: handleEventClick,
  height: 'auto',
}))

onMounted(async () => {
  const subToken = route.params.sub_token as string
  try {
    const data = await api.getCalendarData(subToken)
    semester.value = data.semester ? `${data.semester} 课表` : '课表日历'
    events.value = data.events.map(toCalendarEvent)
  } catch (err) {
    error.value = parseApiError(err, '加载课表数据失败')
  } finally {
    loading.value = false
  }
})
</script>
```

> **Note on CSS import:** `@fullcalendar/core/main.css` is the v6 base stylesheet. If the actual path differs after install, check `node_modules/@fullcalendar/core/` for the correct CSS file name (may be `index.css` or similar). Adjust the import accordingly.

**Step 2: Verify the component has no syntax errors**

Run:
```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -c "Calendar.vue" || echo "0 errors"
```

**Step 3: Commit**

```bash
git add frontend/src/views/Calendar.vue
git commit -m "feat: add Calendar view with FullCalendar"
```

---

### Task 5: Add route and update test-utils

**Files:**
- Modify: `frontend/src/router/index.ts` — add `/calendar/:sub_token` route and `Calendar` route name
- Modify: `frontend/src/test-utils.ts` — add calendar route to test router

**Step 1: Update router**

In `frontend/src/router/index.ts`:

Add `Calendar: 'Calendar'` to `RouteNames`:

```typescript
export const RouteNames = {
  Home: 'Home',
  Login: 'Login',
  Register: 'Register',
  Recover: 'Recover',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
  Changelog: 'Changelog',
  Calendar: 'Calendar',
} as const
```

Add route entry after the changelog route (before the closing `]`):

```typescript
  {
    path: '/calendar/:sub_token',
    name: RouteNames.Calendar,
    component: () => import('@/views/Calendar.vue'),
    meta: { title: `课表日历 | ${SITE_NAME}` }
  }
```

**Step 2: Update test-utils**

In `frontend/src/test-utils.ts`, add to the `routes` array:

```typescript
  { path: '/calendar/:sub_token', name: RouteNames.Calendar, component: { template: '<div>Calendar</div>' } },
```

**Step 3: Add `getCalendarData` to mock API**

In `frontend/src/test-utils.ts`, add to the `createMockApi()` return object:

```typescript
    getCalendarData: vi.fn().mockResolvedValue({ semester: '2025秋', semester_start: '2025-09-01', generated_at: new Date().toISOString(), events: [] }),
```

**Step 4: Commit**

```bash
git add frontend/src/router/index.ts frontend/src/test-utils.ts
git commit -m "feat: add /calendar/:sub_token route"
```

---

### Task 6: Add "View Calendar" button to Dashboard

**Files:**
- Modify: `frontend/src/views/Dashboard.vue`

**Step 1: Add Calendar icon import**

In the lucide imports line (~line 232), add `Calendar`:

```typescript
import { RefreshCw, Loader2, Copy, Check, X, Trash2, QrCode, Download, Calendar } from 'lucide-vue-next'
```

**Step 2: Add calendar button to subscription card actions**

In the button group (`<div class="flex gap-2">` inside `<CardContent>`, ~line 67), add this button after the QR code button and before the refresh button:

```vue
              <router-link :to="{ name: 'Calendar', params: { sub_token: sub.calendar_token } }">
                <Button variant="outline" size="sm" class="cursor-pointer">
                  <Calendar class="h-4 w-4 mr-1.5" />
                  日历
                </Button>
              </router-link>
```

**Step 3: Verify frontend builds**

Run:
```bash
cd frontend && npm run build
```
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/src/views/Dashboard.vue
git commit -m "feat: add calendar view button to Dashboard subscription cards"
```

---

### Task 7: Add FullCalendar to Vite manualChunks

**Files:**
- Modify: `frontend/vite.config.ts`

**Step 1: Add fullcalendar chunk**

In the `manualChunks` object (~line 38-41), add a new entry:

```typescript
            fullcalendar: ['@fullcalendar/core', '@fullcalendar/vue3', '@fullcalendar/daygrid', '@fullcalendar/timegrid'],
```

**Step 2: Verify build**

Run:
```bash
cd frontend && npm run build
```
Expected: Build succeeds, output shows a separate `fullcalendar-*.js` chunk.

**Step 3: Commit**

```bash
git add frontend/vite.config.ts
git commit -m "perf: add FullCalendar to manualChunks for code splitting"
```

---

### Task 8: Add FullCalendar mock to test-setup and write Calendar view tests

**Files:**
- Modify: `frontend/src/test-setup.ts` — add FullCalendar global mock
- Create: `frontend/src/views/__tests__/Calendar.test.ts`

**Step 1: Add FullCalendar mock to test-setup.ts**

Append to `frontend/src/test-setup.ts`:

```typescript
// Mock @fullcalendar/vue3
vi.mock('@fullcalendar/vue3', () => ({
  default: {
    name: 'FullCalendar',
    template: '<div data-testid="fullcalendar" />',
    props: ['options'],
  },
}))

// Mock FullCalendar plugins (they export plugin objects)
vi.mock('@fullcalendar/daygrid', () => ({ default: {} }))
vi.mock('@fullcalendar/timegrid', () => ({ default: {} }))
```

**Step 2: Write Calendar view tests**

Create `frontend/src/views/__tests__/Calendar.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import CalendarView from '@/views/Calendar.vue'
import { mountWithContext, createMockApi } from '@/test-utils'
import type { FormattedEvent } from '@/types/api'

const mockApi = createMockApi()
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
```

**Step 3: Run tests**

Run:
```bash
npm run test:frontend
```
Expected: All tests pass, including the new Calendar tests.

**Step 4: Commit**

```bash
git add frontend/src/test-setup.ts frontend/src/views/__tests__/Calendar.test.ts
git commit -m "test: add Calendar view tests with FullCalendar mock"
```

---

### Task 9: Final verification

**Step 1: Run all frontend tests**

Run:
```bash
npm run test:frontend
```
Expected: All tests pass (existing + new Calendar tests).

**Step 2: Run backend tests**

Run:
```bash
npx vitest run --exclude 'frontend/**'
```
Expected: All backend tests pass (no changes to backend).

**Step 3: Build frontend**

Run:
```bash
cd frontend && npm run build
```
Expected: Build succeeds, output shows separate `fullcalendar` chunk.

**Step 4: Manual smoke test (optional)**

Run:
```bash
npm run dev:frontend
```
Navigate to `http://localhost:5173/calendar/<a-valid-sub-token>` and verify:
- Calendar renders with week view
- Events display correctly
- Day/week/month switching works
- Clicking an event shows the detail dialog
- Mobile viewport switches to day view
