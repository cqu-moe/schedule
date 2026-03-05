# Type Safety Refactor Design

Issue: #28 - refactor: improve type safety (SourceType union, Context typing)

## Scope

Full scope: backend SourceType union, Hono Context typing, CQUAPIClient generics, CQU API response interfaces, frontend SourceType.

`lookupUser` (issue item #2) no longer exists in codebase — skipped.

## 1. SourceType Union Type

**Location:** `src/db/schema.ts` (single source of truth)

```typescript
export const SOURCE_TYPES = [
  "personal_all", "personal_courses", "personal_exams",
  "instructor", "room", "laboratory", "course", "admin_class",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const PERSONAL_SOURCE_TYPES = new Set<SourceType>([
  "personal_all", "personal_courses", "personal_exams",
]);

export const EXPLORE_SOURCE_TYPES = new Set<SourceType>([
  "instructor", "room", "laboratory", "course", "admin_class",
]);
```

Derive `ExploreSourceType` for `TABLE_DETAIL_URLS`:
```typescript
export type ExploreSourceType = Extract<SourceType,
  "instructor" | "room" | "laboratory" | "course" | "admin_class">;
```

**Files to update:**
- `src/services/sync.ts` — remove local `PERSONAL_SOURCE_TYPES`, import from schema
- `src/routes/subscriptions.ts` — remove inline `validTypes` array, use `EXPLORE_SOURCE_TYPES.has()`
- `src/services/cqu-api.ts` — `TABLE_DETAIL_URLS` key type → `Record<ExploreSourceType, string>`
- `src/routes/users.ts` — type-annotate `personalSubValues` sourceType fields

## 2. Hono Context Typing

Replace `any` with proper Hono Context type:

```typescript
// subscriptions.ts
getSubForExport(c: Context<{ Bindings: Env }>) // was: c: any
```

## 3. CQUAPIClient.request() Generic

```typescript
private async request<T = unknown>(
  method: string,
  url: string,
  options?: { json?: unknown; params?: Record<string, string | number>; timeout?: number },
): Promise<T> {
  // ...
  return (await response.json()) as T;
}
```

Default `unknown` forces callers to handle types explicitly.

## 4. CQU API Response Interfaces

Key-path-only interfaces, internal to `cqu-api.ts` (not exported). Only define fields the code actually accesses.

Replace `parseCourses(data: any)` → `parseCourses(data: unknown)` with internal type assertions or guards. Same for `parseExams`, `formatDepartment`, and other parse functions.

Example:
```typescript
interface CourseRawItem {
  courseName: string;
  // ... only fields accessed in parseCourses
}
```

## 5. Frontend SourceType

**Location:** `frontend/src/types/api.ts` (independent definition, same values)

```typescript
export type SourceType =
  | "personal_all" | "personal_courses" | "personal_exams"
  | "instructor" | "room" | "laboratory" | "course" | "admin_class";

export interface Subscription {
  source_type: SourceType; // was: string
  // ...
}
```

Frontend and backend maintain separate copies (independent npm project boundary).

## Design Decisions

- **SourceType defined in schema.ts** — it's a database field constraint, natural home
- **Key-path interfaces over full API types** — CQU API is third-party, full response types would be maintenance burden
- **`unknown` default over `any`** — forces explicit type handling without over-specifying
- **Separate frontend type** — respects independent npm project boundary
