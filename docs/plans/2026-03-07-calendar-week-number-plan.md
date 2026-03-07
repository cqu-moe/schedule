# Calendar Week Number Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show semester week numbers in the calendar view — per-row in month view, appended to toolbar title in day/week views.

**Architecture:** Pure function `getSemesterWeek()` calculates week number from `semester_start`. FullCalendar's `weekNumbers` + `weekNumberContent` handles month view. `datesSet` callback + DOM manipulation handles day/week view toolbar.

**Tech Stack:** Vue 3, FullCalendar v6, TypeScript

---

### Task 1: Add `getSemesterWeek` unit tests

**Files:**
- Create: `frontend/src/views/__tests__/calendarWeek.test.ts`

**Step 1: Write the tests**

```typescript
import { describe, it, expect } from 'vitest'
import { getSemesterWeek } from '@/views/Calendar.vue'

describe('getSemesterWeek', () => {
  const semesterStart = '2025-09-01' // Monday

  it('returns 1 for the first day of semester', () => {
    expect(getSemesterWeek(new Date('2025-09-01'), semesterStart)).toBe(1)
  })

  it('returns 1 for Sunday of first week', () => {
    expect(getSemesterWeek(new Date('2025-09-07'), semesterStart)).toBe(1)
  })

  it('returns 2 for Monday of second week', () => {
    expect(getSemesterWeek(new Date('2025-09-08'), semesterStart)).toBe(2)
  })

  it('returns 22 for the last valid week', () => {
    // Week 22 starts at day 147 (21*7), which is 2026-01-26
    expect(getSemesterWeek(new Date('2026-01-26'), semesterStart)).toBe(22)
  })

  it('returns null before semester starts', () => {
    expect(getSemesterWeek(new Date('2025-08-31'), semesterStart)).toBeNull()
  })

  it('returns null after week 22', () => {
    // Week 23 starts at day 154, which is 2026-02-02
    expect(getSemesterWeek(new Date('2026-02-02'), semesterStart)).toBeNull()
  })

  it('returns null for empty semesterStart', () => {
    expect(getSemesterWeek(new Date('2025-09-01'), '')).toBeNull()
  })

  it('returns null for invalid semesterStart', () => {
    expect(getSemesterWeek(new Date('2025-09-01'), 'invalid')).toBeNull()
  })

  it('handles mid-week semester start correctly', () => {
    // If semester starts on Wednesday 2025-09-03, week 1 should be Mon 2025-09-01 to Sun 2025-09-07
    // The function aligns to the Monday of the semester start week
    const wedStart = '2025-09-03' // Wednesday
    expect(getSemesterWeek(new Date('2025-09-01'), wedStart)).toBe(1) // Monday of same week
    expect(getSemesterWeek(new Date('2025-09-07'), wedStart)).toBe(1) // Sunday of same week
    expect(getSemesterWeek(new Date('2025-09-08'), wedStart)).toBe(2) // Next Monday
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/__tests__/calendarWeek.test.ts`
Expected: FAIL — `getSemesterWeek` is not exported from Calendar.vue

---

### Task 2: Implement `getSemesterWeek` and export it

**Files:**
- Modify: `frontend/src/views/Calendar.vue`

**Step 1: Add the function before the component logic (after imports, before `COURSE_COLORS`)**

```typescript
// Exported for testing
export function getSemesterWeek(date: Date, semesterStart: string): number | null {
  if (!semesterStart) return null
  const termStart = new Date(semesterStart + 'T00:00:00')
  if (isNaN(termStart.getTime())) return null

  // Align to Monday of the semester start week
  const day = termStart.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const monday = new Date(termStart)
  monday.setDate(monday.getDate() + mondayOffset)

  const diffMs = date.getTime() - monday.getTime()
  if (diffMs < 0) return null

  const week = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1
  return week >= 1 && week <= 22 ? week : null
}
```

**Step 2: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/views/__tests__/calendarWeek.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/calendarWeek.test.ts frontend/src/views/Calendar.vue
git commit -m "feat: add getSemesterWeek calculation with tests"
```

---

### Task 3: Save `semester_start` and wire up FullCalendar week numbers

**Files:**
- Modify: `frontend/src/views/Calendar.vue`

**Step 1: Add `semesterStart` ref and save it from API response**

In the `<script setup>` section, add a ref:

```typescript
const semesterStart = ref('')
```

In `onMounted`, after `semester.value = ...`, add:

```typescript
semesterStart.value = data.semester_start ?? ''
```

**Step 2: Add month view week numbers to `calendarOptions`**

Add these properties to the `calendarOptions` computed:

```typescript
weekNumbers: true,
weekNumberContent: (arg: { num: number; date: Date }) => {
  const week = getSemesterWeek(arg.date, semesterStart.value)
  return week !== null ? { html: `<span class="text-xs text-muted-foreground">W${week}</span>` } : { html: '' }
},
```

Import `WeekNumberContentArg` is not needed — use inline type as shown above (FullCalendar types the arg in CalendarOptions).

**Step 3: Add `datesSet` callback for day/week view toolbar week number**

Add this function before `calendarOptions`:

```typescript
function handleDatesSet(arg: { view: { type: string }; start: Date; end: Date }) {
  // Determine the reference date: Monday for week view, the day for day view
  const viewType = arg.view.type
  if (viewType === 'dayGridMonth') return // Month view uses weekNumbers

  let refDate: Date
  if (viewType === 'timeGridWeek') {
    refDate = arg.start // FullCalendar week view start is Monday (firstDay: 1)
  } else {
    refDate = arg.start
  }

  const week = getSemesterWeek(refDate, semesterStart.value)

  // Find the toolbar title and append/update week label
  requestAnimationFrame(() => {
    const titleEl = document.querySelector('.fc-toolbar-title')
    if (!titleEl) return

    // Remove existing week label
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
```

Add `datesSet: handleDatesSet` to `calendarOptions`.

**Step 4: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: All tests PASS (FullCalendar is mocked, so new options don't affect existing tests)

**Step 5: Commit**

```bash
git add frontend/src/views/Calendar.vue
git commit -m "feat: display semester week numbers in calendar view"
```

---

### Task 4: Visual verification

**Step 1: Build frontend**

Run: `npm run build:frontend`
Expected: Build succeeds

**Step 2: Manual visual check**

Run: `npm run dev:frontend`

Verify:
- Day/week view: toolbar title shows "· 第X周" after the date range
- Month view: each row's left side shows "W1", "W2", etc. for weeks in semester range
- Rows outside semester range show no week number
- Navigating between views updates correctly

**Step 3: Commit any adjustments if needed**
