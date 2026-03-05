# Type Safety Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate `any` types and enforce SourceType union across the codebase (#28)

**Architecture:** Define `SourceType` union in schema.ts as single source of truth, then propagate through services/routes/frontend. Replace `CQUAPIClient.request()` return type with generics and define key-path-only response interfaces.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Vue 3

---

### Task 1: Define SourceType union and derived sets in schema.ts

**Files:**
- Modify: `src/db/schema.ts:105-111`

**Step 1: Add SourceType definitions after the subscriptions table, before type exports**

```typescript
// ── Source type constants ────────────────────────────────────────────────────

export const SOURCE_TYPES = [
  "personal_all",
  "personal_courses",
  "personal_exams",
  "instructor",
  "room",
  "laboratory",
  "course",
  "admin_class",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export type PersonalSourceType = Extract<SourceType, "personal_all" | "personal_courses" | "personal_exams">;
export type ExploreSourceType = Extract<SourceType, "instructor" | "room" | "laboratory" | "course" | "admin_class">;

export const PERSONAL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<PersonalSourceType>([
  "personal_all",
  "personal_courses",
  "personal_exams",
]);

export const EXPLORE_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<ExploreSourceType>([
  "instructor",
  "room",
  "laboratory",
  "course",
  "admin_class",
]);
```

Note: `PERSONAL_SOURCE_TYPES` typed as `ReadonlySet<SourceType>` (not `ReadonlySet<PersonalSourceType>`) so `.has(sub.sourceType)` works when `sub.sourceType` is `string` from DB. Same for `EXPLORE_SOURCE_TYPES`.

**Step 2: Update the sourceType comment on line 54-58**

Replace the comment block:
```typescript
    /** Source type: see SourceType union */
    sourceType: text("source_type").notNull(),
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (additive changes only)

**Step 4: Commit**

```
git add src/db/schema.ts
git commit -m "refactor: define SourceType union and derived sets in schema (#28)"
```

---

### Task 2: Migrate sync.ts to use schema SourceType

**Files:**
- Modify: `src/services/sync.ts:1-21,105-109,141-148`

**Step 1: Update imports and remove local PERSONAL_SOURCE_TYPES**

Replace lines 1-21:
```typescript
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  subscriptions,
  PERSONAL_SOURCE_TYPES,
  type SourceType,
  type ExploreSourceType,
} from "../db/schema";
import {
  CQUAPIClient,
  type CourseEntry,
  type ExamEntry,
  type SemesterInfo,
} from "./cqu-api";
import {
  generateCoursesIcs,
  generateExamsIcs,
  mergeIcs,
  EMPTY_ICS,
} from "./ics";
```

Remove the old `PERSONAL_SOURCE_TYPES` definition (lines 17-21 currently) — it's now imported from schema.

**Step 2: Type the sourceType parameters**

In `buildPersonalSyncResult` (line ~106):
```typescript
export async function buildPersonalSyncResult(
  sourceType: SourceType,  // was: string
  data: PersonalScheduleData,
  studentId: string,
): Promise<SyncResult> {
```

In `buildExploreSyncResult` (line ~142):
```typescript
export async function buildExploreSyncResult(
  api: CQUAPIClient,
  sourceType: ExploreSourceType,  // was: string
  sourceId: string,
  studentId: string,
  ctx: SessionContext,
): Promise<SyncResult> {
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Errors in callers that pass `string` — this is expected and will be fixed in subsequent tasks.

**Step 4: Run tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: PASS (runtime behavior unchanged)

**Step 5: Commit**

```
git add src/services/sync.ts
git commit -m "refactor: use SourceType union in sync.ts (#28)"
```

---

### Task 3: Update subscriptions.ts — remove inline validTypes, fix `any` params

**Files:**
- Modify: `src/routes/subscriptions.ts`

**Step 1: Update imports**

Add to imports from schema:
```typescript
import { subscriptions, type Subscription, EXPLORE_SOURCE_TYPES, type SourceType, type ExploreSourceType } from "../db/schema";
```

Remove `PERSONAL_SOURCE_TYPES` from sync imports (it's now from schema):
```typescript
import {
  fetchSessionContextCached,
  fetchPersonalScheduleCached,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
} from "../services/sync";
import { PERSONAL_SOURCE_TYPES } from "../db/schema";
```

**Step 2: Replace inline validTypes array (lines 97-106)**

Replace:
```typescript
  const validTypes = [
    "instructor",
    "room",
    "laboratory",
    "course",
    "admin_class",
  ];
  if (!validTypes.includes(body.source_type)) {
    return errorResponse("BAD_REQUEST", "Invalid source_type", 400);
  }
```

With:
```typescript
  if (!EXPLORE_SOURCE_TYPES.has(body.source_type as SourceType)) {
    return errorResponse("BAD_REQUEST", "Invalid source_type", 400);
  }
```

Note: `body.source_type` is user input (`string`), so we cast for the `.has()` check. The `has()` will return `false` for invalid values, which is correct behavior.

**Step 3: Fix getSubForExport parameter type (line 383)**

Replace:
```typescript
async function getSubForExport(c: any): Promise<ExportSub | Response> {
```

With:
```typescript
async function getSubForExport(c: Context<{ Bindings: Env }>): Promise<ExportSub | Response> {
```

Add import at top:
```typescript
import type { Context } from "hono";
```

**Step 4: Fix parseSubJson return type (line 372)**

Replace:
```typescript
function parseSubJson(sub: ExportSub): { courses: any[] | null; exams: any[] | null } | null {
```

With:
```typescript
function parseSubJson(sub: ExportSub): { courses: CourseEntry[] | null; exams: ExamEntry[] | null } | null {
```

Add to cqu-api imports:
```typescript
import { CQUAPIClient, type CourseEntry, type ExamEntry } from "../services/cqu-api";
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Run tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: PASS

**Step 7: Commit**

```
git add src/routes/subscriptions.ts
git commit -m "refactor: use SourceType union and fix any params in subscriptions.ts (#28)"
```

---

### Task 4: Update cqu-api.ts — generic request(), typed TABLE_DETAIL_URLS, response interfaces

**Files:**
- Modify: `src/services/cqu-api.ts`

**Step 1: Add import and type TABLE_DETAIL_URLS**

Add import at top:
```typescript
import type { ExploreSourceType } from "../db/schema";
```

Replace line 29:
```typescript
const TABLE_DETAIL_URLS: Record<ExploreSourceType, string> = {
```

**Step 2: Make request() generic**

Replace lines 125-129:
```typescript
  private async request<T = unknown>(
    method: string,
    url: string,
    options?: { json?: unknown; params?: Record<string, string | number>; timeout?: number },
  ): Promise<T> {
```

Replace line 191 (`return response.json();`):
```typescript
    return (await response.json()) as T;
```

**Step 3: Define internal response interfaces**

Add before the class definition (after `formatUrl`):

```typescript
// ── CQU API response interfaces (key-path only) ────────────────────────────

interface SessionListResponse {
  curSessionId?: string;
  sessionFinder?: Array<{ id?: string; name?: string }>;
}

interface SessionDetailResponse {
  data?: {
    id?: string;
    year?: string;
    term?: string;
    beginDate?: string;
    endDate?: string;
  };
}

interface ScheduleResponse {
  classTimetableVOList?: Array<{
    courseName?: string;
    instructorName?: string;
    roomName?: string;
    position?: string;
    campusName?: string;
    weekDay?: string | number;
    teachingWeek?: string;
    period?: string;
  }>;
}

interface ExamListResponse {
  status?: string;
  data?: {
    content?: Array<{
      courseName?: string;
      examDate?: string;
      startTime?: string;
      endTime?: string;
      roomName?: string;
      seatNum?: string | number;
    }>;
  };
}

interface InstructorItem {
  id: string;
  name: string;
  departmentName?: string;
  code?: string;
}

interface RoomItem {
  id: string | number;
  name: string;
  capacity?: number | string;
}

interface LabItem {
  id: string | number;
  roomName?: string;
  campusName?: string;
  buildingName?: string;
}

interface CourseSearchResponse {
  data?: Array<{ id: string; name: string; number?: string; credit?: string | number }>;
}

interface CourseClassItem {
  id: string | number;
  classNbr?: string;
}

interface AdminClassItem {
  id: string | number;
  className?: string;
  grade?: string;
  personNumber?: number | string;
}

interface DepartmentRawItem {
  id: string | number;
  name: string;
  subDepartmentVOList?: DepartmentRawItem[];
}
```

**Step 4: Update method signatures to use typed request()**

`getSessionList`:
```typescript
  async getSessionList(): Promise<{
    current_session_id: string;
    sessions: Record<string, SessionInfo>;
  }> {
    const data = await this.request<SessionListResponse>("GET", SESSION_LIST_URL);

    const curSessionId: string = data.curSessionId ?? "";
    const sessionFinder = data.sessionFinder ?? [];

    const sessions: Record<string, SessionInfo> = {};
    for (const item of sessionFinder) {
      if (item?.id && item?.name) {
        sessions[item.id] = { id: item.id, name: item.name };
      }
    }

    return { current_session_id: curSessionId, sessions };
  }
```

`getSemesterInfo`:
```typescript
  async getSemesterInfo(termId: string): Promise<SemesterInfo> {
    const url = formatUrl(SESSION_DETAIL_URL_TEMPLATE, termId);
    const jsonData = await this.request<SessionDetailResponse>("GET", url);

    const data = jsonData.data ?? {};
    // ... rest unchanged
  }
```

`getSchedule`:
```typescript
  async getSchedule(
    studentId: string,
    termId: string,
  ): Promise<CourseEntry[]> {
    const url = formatUrl(SCHEDULE_URL_TEMPLATE, termId);
    const data = await this.request<ScheduleResponse>("POST", url, { json: [studentId] });
    return this.parseCourses(data);
  }
```

`parseCourses`:
```typescript
  private parseCourses(data: ScheduleResponse): CourseEntry[] {
    const courses: CourseEntry[] = [];
    const timetableList = data.classTimetableVOList ?? [];
    // ... rest unchanged (remove any[] type annotations)
  }
```

`getExams` + `parseExams`:
```typescript
  async getExams(): Promise<ExamEntry[]> {
    const data = await this.request<ExamListResponse>("GET", EXAM_URL);
    return this.parseExams(data);
  }

  private parseExams(data: ExamListResponse): ExamEntry[] {
    const exams: ExamEntry[] = [];
    if (data.status !== "success") return [];
    const examList = data.data?.content ?? [];
    // ... rest unchanged (remove any[] type annotations)
  }
```

`searchInstructor`:
```typescript
  async searchInstructor(keyword: string): Promise<SearchResult[]> {
    const data = await this.request<InstructorItem[]>("GET", INSTRUCTOR_SEARCH_URL, {
      params: { nameOrCode: keyword, limitNum: 50 },
    });
    return data.map((item) => ({
      id: item.id,
      name: item.name,
      extra: `${item.departmentName ?? ""} / ${item.code ?? ""}`,
    }));
  }
```

`searchRoom`:
```typescript
  async searchRoom(keyword: string): Promise<SearchResult[]> {
    const data = await this.request<RoomItem[]>("GET", ROOM_SEARCH_URL, {
      params: { roomName: keyword, limitNum: 200 },
    });
    return data.map((item) => ({
      id: String(item.id),
      name: item.name,
      extra: `容量: ${item.capacity ?? "未知"}`,
    }));
  }
```

`searchLaboratory`:
```typescript
  async searchLaboratory(keyword: string): Promise<SearchResult[]> {
    const data = await this.request<LabItem[]>("GET", LAB_SEARCH_URL, {
      params: { roomName: keyword, limitNum: 200 },
    });
    return data.map((item) => ({
      id: String(item.id),
      name: item.roomName ?? "",
      extra: `${item.campusName ?? ""} / ${item.buildingName ?? ""}`,
    }));
  }
```

`searchCourse`:
```typescript
  async searchCourse(
    keyword: string,
    sessionId: string,
  ): Promise<SearchResult[]> {
    const courseData = await this.request<CourseSearchResponse | Array<{ id: string; name: string; number?: string; credit?: string | number }>>("GET", COURSE_SEARCH_URL, {
      params: { nameOrCode: keyword, pageSize: 50, sessionId },
    });

    const courses = (
      typeof courseData === "object" && !Array.isArray(courseData)
        ? (courseData as CourseSearchResponse).data ?? []
        : courseData as Array<{ id: string; name: string; number?: string; credit?: string | number }>
    ).slice(0, 10);

    const results: SearchResult[] = [];

    const classPromises = courses.map(async (course) => {
      try {
        const classes = await this.request<CourseClassItem[]>("GET", COURSE_CLASS_SEARCH_URL, {
          params: { courseId: course.id, sessionId },
        });
        return classes.map((cls) => ({
          id: String(cls.id),
          name: `${course.name} (${cls.classNbr ?? ""})`,
          extra: `课程代码: ${course.number ?? ""} / 学分: ${course.credit ?? ""}`,
        }));
      } catch {
        return [];
      }
    });

    const classLists = await Promise.all(classPromises);
    for (const list of classLists) {
      results.push(...list);
    }

    return results;
  }
```

`searchAdminClass`:
```typescript
  async searchAdminClass(
    departmentId: string,
    grade?: string,
    className?: string,
  ): Promise<SearchResult[]> {
    const params: Record<string, string | number> = { pageSize: 200 };
    if (grade) params.grade = grade;
    if (className) params.className = className;

    const data = await this.request<AdminClassItem[]>("POST", ADMIN_CLASS_SEARCH_URL, {
      params,
      json: [departmentId],
    });

    return data.map((item) => ({
      id: String(item.id),
      name: item.className ?? "",
      extra: `${item.grade ?? ""}级 / ${item.personNumber ?? ""}人`,
    }));
  }
```

`getDepartments`:
```typescript
  async getDepartments(): Promise<DepartmentNode[]> {
    const data = await this.request<DepartmentRawItem[] | { data?: DepartmentRawItem[] }>("GET", DEPARTMENT_LIST_URL);
    const items: DepartmentRawItem[] =
      typeof data === "object" && !Array.isArray(data)
        ? (data as { data?: DepartmentRawItem[] }).data ?? []
        : data as DepartmentRawItem[];
    return items.map(formatDepartment);
  }
```

`fetchTargetSchedule`:
```typescript
  async fetchTargetSchedule(
    sourceType: ExploreSourceType,  // was: string
    sourceId: string,
    sessionId: string,
  ): Promise<CourseEntry[]> {
    const urlTemplate = TABLE_DETAIL_URLS[sourceType];
    const url = formatUrl(urlTemplate, sessionId);
    const data = await this.request<ScheduleResponse>("POST", url, { json: [sourceId], timeout: 60000 });
    return this.parseCourses(data);
  }
```

Note: Since `sourceType` is now `ExploreSourceType` and `TABLE_DETAIL_URLS` has the same key type, `urlTemplate` is guaranteed to be `string` — remove the `if (!urlTemplate)` guard.

`formatDepartment`:
```typescript
function formatDepartment(item: DepartmentRawItem): DepartmentNode {
  const result: DepartmentNode = {
    id: String(item.id),
    name: item.name,
  };
  const subs = item.subDepartmentVOList ?? [];
  if (subs.length > 0) {
    result.children = subs.map(formatDepartment);
  }
  return result;
}
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Run tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: PASS

**Step 7: Commit**

```
git add src/services/cqu-api.ts
git commit -m "refactor: generic request(), typed response interfaces in cqu-api.ts (#28)"
```

---

### Task 5: Update remaining callers — users.ts, schedule-sync.ts, middleware/auth.ts, export.ts

**Files:**
- Modify: `src/routes/users.ts:135-148,271-276`
- Modify: `src/middleware/auth.ts:14`
- Modify: `src/services/export.ts:36-39`

**Step 1: Type personalSubValues in users.ts**

Replace lines 135-148:
```typescript
  const personalSubValues: Array<{
    sourceType: PersonalSourceType;
    sourceName: string;
  }> = [
    { sourceType: "personal_all", sourceName: "全部课表" },
    { sourceType: "personal_courses", sourceName: "仅课程" },
    { sourceType: "personal_exams", sourceName: "仅考试" },
  ];
```

Wait — actually this is passed to `db.insert().values()` so we need to keep the full structure. Better approach — just add `as const` or use the type inline:

Replace lines 135-148 with typed sourceType:
```typescript
  const personalSubValues = ([
    { sourceType: "personal_all" as const, sourceName: "全部课表" },
    { sourceType: "personal_courses" as const, sourceName: "仅课程" },
    { sourceType: "personal_exams" as const, sourceName: "仅考试" },
  ]).map(({ sourceType, sourceName }) => ({
    userId: newUser.id,
    sourceType,
    sourceId: student_id,
    sourceName,
    calendarToken: generateToken(),
    isPersonal: true,
    createdAt: now,
    updatedAt: now,
  }));
```

Add import:
```typescript
import { users, subscriptions, type SourceType } from "../db/schema";
```

Also update `syncNewUserSubscriptions` parameter (line 276):
```typescript
export async function syncNewUserSubscriptions(
  env: Env,
  userId: string,
  studentId: string,
  accessToken: string,
  subIds: { id: string; sourceType: SourceType }[],  // was: string
): Promise<void> {
```

**Step 2: Fix parseToken in middleware/auth.ts**

Replace line 14:
```typescript
function parseToken(c: Context<{ Bindings: Env }>): string | Response {
```

Add import:
```typescript
import type { Context } from "hono";
```

Wait — `createMiddleware` already provides typed context. Actually `parseToken` is called with `c` from middleware which is already typed. The issue is `parseToken` accepts `any` so it works with both middleware contexts. The simplest fix — use a minimal type that covers both:

```typescript
function parseToken(c: { req: { header: (name: string) => string | undefined } }): string | Response {
```

Actually that's over-engineered. Since the middleware contexts both have `Bindings: Env`, and the function only uses `c.req.header()`, we can use Hono's base Context:

```typescript
import type { Context } from "hono";

function parseToken(c: Context): string | Response {
```

This works because `Context` has `req.header()` without needing specific bindings.

**Step 3: Fix export.ts parameter types**

Replace lines 36-39:
```typescript
export function generateFormattedEvents(
  coursesJson: CourseEntry[] | null,
  semesterStart: string,
  examsJson?: ExamEntry[] | null,
): FormattedEvent[] {
```

Add import:
```typescript
import { TIME_SLOTS, type CourseEntry, type ExamEntry } from "./cqu-api";
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Run tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: PASS

**Step 6: Commit**

```
git add src/routes/users.ts src/middleware/auth.ts src/services/export.ts
git commit -m "refactor: propagate SourceType to users.ts, auth middleware, export.ts (#28)"
```

---

### Task 6: Fix auth.ts `any` types (bonus — not in issue but discovered)

**Files:**
- Modify: `src/services/auth.ts`

The `any` types in auth.ts are mostly for `catch (e: any)` and JSON response parsing. These are lower priority but should be cleaned up for consistency.

**Step 1: Replace `catch (e: any)` with `catch (e: unknown)` or `catch (e)`**

TypeScript 4.4+ allows `catch (e)` where `e` is `unknown`. Replace all `catch (e: any)` with `catch (e)` and use type narrowing where the error properties are accessed.

**Step 2: Add response interfaces for SSO/OAuth endpoints**

Define minimal interfaces for the JSON bodies actually accessed:
```typescript
interface SsoLoginPageData {
  // Only if specific fields are accessed
}
```

Review each `any` cast in auth.ts and replace with `unknown` + type narrowing or a minimal interface. Since auth.ts has complex SSO parsing, use `unknown` with optional chaining where practical.

**Step 3: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run --exclude 'frontend/**'`
Expected: PASS

**Step 4: Commit**

```
git add src/services/auth.ts
git commit -m "refactor: replace any types in auth.ts (#28)"
```

---

### Task 7: Update frontend SourceType

**Files:**
- Modify: `frontend/src/types/api.ts:8-17`

**Step 1: Add SourceType and update Subscription interface**

```typescript
export type SourceType =
  | "personal_all"
  | "personal_courses"
  | "personal_exams"
  | "instructor"
  | "room"
  | "laboratory"
  | "course"
  | "admin_class";

export interface Subscription {
  calendar_token: string
  source_type: SourceType  // was: string
  source_id: string
  source_name: string
  is_personal: boolean
  session_name: string
  last_synced_at: string | null
  subscription_url: string
}
```

**Step 2: Run frontend typecheck**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: Check for any errors related to `source_type` comparisons. Fix if needed.

**Step 3: Run frontend tests**

Run: `npm run test:frontend`
Expected: PASS

**Step 4: Commit**

```
git add frontend/src/types/api.ts
git commit -m "refactor: add SourceType union to frontend types (#28)"
```

---

### Task 8: Final verification

**Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 2: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: PASS

**Step 3: Run all frontend tests**

Run: `npm run test:frontend`
Expected: PASS

**Step 4: Run frontend build**

Run: `cd frontend && npm run build`
Expected: PASS

**Step 5: Grep for remaining `any` in modified files**

Run: `grep -n ': any' src/db/schema.ts src/services/sync.ts src/routes/subscriptions.ts src/services/cqu-api.ts src/routes/users.ts src/middleware/auth.ts src/services/export.ts src/services/auth.ts frontend/src/types/api.ts`
Expected: No matches (or only in test files / catch blocks which are acceptable)

**Step 6: Done — ready for PR**
