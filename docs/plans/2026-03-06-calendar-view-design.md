# Calendar View Design

## Overview

Add a calendar display feature to visualize subscription schedules. Each subscription gets its own calendar view at `/calendar/:sub_token`, publicly accessible (consistent with existing ICS/JSON export endpoints). Uses FullCalendar for day/week/month view switching.

## Data Flow

```
User clicks "View Calendar" on Dashboard subscription card
  -> Frontend routes to /calendar/:sub_token
  -> fetch GET /api/v1/subscriptions/:sub_token/data.json
  -> Map FormattedEvent[] to FullCalendar EventInput[]
  -> FullCalendar renders
```

No new backend endpoints needed. The existing `data.json` public endpoint returns `FormattedEvent[]` with `start_time`, `end_time` (ISO format), `name`, `location`, `instructor`, `type` (course/exam).

## Route & Page

- **Route**: `/calendar/:sub_token` — public, no auth required
- **View**: `frontend/src/views/Calendar.vue`
- **Route name**: `Calendar` (added to `RouteNames`)
- **Title**: `课表日历 | CQU Schedule`
- **Dashboard entry**: Add a calendar icon button on each subscription card, linking to `/calendar/:sub_token`

## Dependencies

```
@fullcalendar/vue3    — Vue 3 component
@fullcalendar/core    — Core library
@fullcalendar/daygrid — Month view plugin
@fullcalendar/timegrid — Day/Week view plugin
```

All installed in `frontend/` as dependencies.

## FullCalendar Configuration

- Default view: `timeGridWeek` (most useful for timetables)
- Views: `timeGridDay` / `timeGridWeek` / `dayGridMonth`
- Locale: `zh-cn`
- Timezone: `Asia/Chongqing`
- Time range: `slotMinTime: '08:00'`, `slotMaxTime: '22:00'`
- Week start: Monday (`firstDay: 1`)
- Header toolbar: prev/next/today buttons + title + view switcher

## Event Mapping

```typescript
function toCalendarEvent(e: FormattedEvent): EventInput {
  return {
    title: e.name,
    start: e.start_time,
    end: e.end_time,
    extendedProps: {
      location: e.location,
      instructor: e.instructor,
      type: e.type,
    },
    backgroundColor: e.type === 'exam' ? 'var(--destructive)' : undefined,
  }
}
```

## UI Details

- **Event popover**: Click an event to show a popover with course name, instructor, location, time
- **Color coding**: Courses use primary theme color, exams use destructive red
- **Responsive**: Mobile defaults to day view
- **Loading state**: Spinner while fetching data
- **Error handling**: Friendly message when token is invalid (404)
- **Navbar**: Standard Navbar at top, page title shows subscription source name

## Style Adaptation

FullCalendar styles need to harmonize with shadcn-vue / Tailwind v4:
- Override FullCalendar CSS variables using shadcn's `--background`, `--foreground`, `--primary`, etc.
- Custom styles in `frontend/src/assets/fullcalendar-theme.css`
- Dark mode support via CSS variable mapping

## Bundle Impact

- FullCalendar packages will be code-split into a separate chunk (lazy-loaded route)
- Only loaded when visiting `/calendar/:sub_token`
- No impact on other pages' bundle size
- Estimated addition: ~50KB gzip (core + 2 plugins)
- Consider adding `fullcalendar` to Vite `manualChunks` config
