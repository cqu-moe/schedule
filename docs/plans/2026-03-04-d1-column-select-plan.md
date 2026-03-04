# D1 Column-Specific Select Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all `.select()` (full-row) D1 queries with column-specific `.select({ ... })` to reduce I/O on hot paths.

**Architecture:** Split auth middleware into two levels (light/full), then systematically update every `.select()` call in routes and cron consumers to only query needed columns. Drizzle ORM infers return types automatically from the select clause.

**Tech Stack:** Drizzle ORM column-specific select, Hono middleware typing, TypeScript Pick types.

---

### Task 1: Auth middleware — define types and split lookups

**Files:**
- Modify: `src/middleware/auth.ts`

**Step 1: Update auth.ts with two user types and two lookup functions**

Replace the entire `src/middleware/auth.ts` with:

```typescript
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, type User } from "../db/schema";
import type { Env } from "../types";

/** Light user: no encrypted fields, for routes that don't need CQU tokens */
export type LightUser = Pick<User, 'id' | 'studentId' | 'calendarToken' | 'createdAt' | 'lastRefreshAt'>;

/** Auth user: adds accessToken for routes that call CQU API */
export type AuthUser = LightUser & Pick<User, 'accessToken'>;

function parseToken(c: any): string | Response {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ detail: "Invalid authorization header" }, 401);
  }
  return authHeader.slice(7);
}

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: LightUser };
}>(async (c, next) => {
  const token = parseToken(c);
  if (token instanceof Response) return token;

  const db = drizzle(c.env.DB);
  const [user] = await db
    .select({
      id: users.id,
      studentId: users.studentId,
      calendarToken: users.calendarToken,
      createdAt: users.createdAt,
      lastRefreshAt: users.lastRefreshAt,
    })
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return c.json({ detail: "Invalid token" }, 401);
  }

  c.set("user", user);
  await next();
});

export const requireAuthWithCquToken = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const token = parseToken(c);
  if (token instanceof Response) return token;

  const db = drizzle(c.env.DB);
  const [user] = await db
    .select({
      id: users.id,
      studentId: users.studentId,
      calendarToken: users.calendarToken,
      createdAt: users.createdAt,
      lastRefreshAt: users.lastRefreshAt,
      accessToken: users.accessToken,
    })
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (!user) {
    return c.json({ detail: "Invalid token" }, 401);
  }

  if (!user.accessToken) {
    return c.json({ detail: "CQU token expired, please re-login" }, 401);
  }

  c.set("user", user);
  await next();
});
```

**Step 2: Update route files to use new types**

In `src/routes/subscriptions.ts`, change the AuthEnv and imports:

- Line 4: change import to `import { type LightUser, type AuthUser } from "../db/schema";` → actually no, import from auth middleware
- Line 6: change import to `import { requireAuth, requireAuthWithCquToken, type LightUser, type AuthUser } from "../middleware/auth";`
- Line 26: change `type AuthEnv = { Bindings: Env; Variables: { user: User } };` to `type AuthEnv = { Bindings: Env; Variables: { user: LightUser | AuthUser } };`
- Remove unused `User` import from `"../db/schema"` (keep `Subscription`)
- In `POST /` handler (line 103), cast user: `const user = c.get("user") as AuthUser;`
- In `POST /:sub_token/refresh` handler (line 238), cast user: `const user = c.get("user") as AuthUser;`

In `src/routes/explore.ts`:
- Line 3: change import to `import { type AuthUser } from "../middleware/auth";` (remove `type User` from schema import)
- Line 9: change `type AuthEnv = { Bindings: Env; Variables: { user: User } };` to `type AuthEnv = { Bindings: Env; Variables: { user: AuthUser } };`

In `src/routes/users.ts`:
- `GET /me` and `DELETE /me` use `requireAuth`. The handler accesses `user.studentId`, `user.calendarToken`, `user.createdAt`, `user.lastRefreshAt`, `user.id` — all in `LightUser`. No cast needed if the app-level type is adjusted.

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with zero errors

**Step 4: Run tests**

Run: `npx vitest run src/`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/middleware/auth.ts src/routes/subscriptions.ts src/routes/explore.ts src/routes/users.ts
git commit -m "refactor(auth): split requireAuth into light/full column selects (#27)"
```

---

### Task 2: Subscriptions routes — column-specific selects

**Files:**
- Modify: `src/routes/subscriptions.ts`

**Step 1: Optimize GET / (list subscriptions)**

At line 36-40, replace `.select()` with metadata-only columns:

```typescript
const subs = await db
  .select({
    calendarToken: subscriptions.calendarToken,
    sourceType: subscriptions.sourceType,
    sourceId: subscriptions.sourceId,
    sourceName: subscriptions.sourceName,
    sessionId: subscriptions.sessionId,
    sessionName: subscriptions.sessionName,
    isPersonal: subscriptions.isPersonal,
    lastSyncedAt: subscriptions.lastSyncedAt,
    createdAt: subscriptions.createdAt,
  })
  .from(subscriptions)
  .where(eq(subscriptions.userId, user.id))
  .orderBy(desc(subscriptions.isPersonal), asc(subscriptions.createdAt));
```

**Step 2: Optimize POST / (create subscription) — count check**

At line 108-111, replace `.select()` with minimal columns for count + dedup:

```typescript
const existingSubs = await db
  .select({
    sourceType: subscriptions.sourceType,
    sourceId: subscriptions.sourceId,
    sessionId: subscriptions.sessionId,
  })
  .from(subscriptions)
  .where(eq(subscriptions.userId, user.id));
```

**Step 3: Optimize DELETE /:sub_token — subscription lookup**

At line 200-209, replace `.select()`:

```typescript
const [sub] = await db
  .select({
    id: subscriptions.id,
    isPersonal: subscriptions.isPersonal,
  })
  .from(subscriptions)
  .where(
    and(
      eq(subscriptions.calendarToken, subToken),
      eq(subscriptions.userId, user.id),
    ),
  )
  .limit(1);
```

**Step 4: Optimize POST /:sub_token/refresh — subscription lookup**

At line 225-234, replace `.select()`:

```typescript
const [sub] = await db
  .select({
    id: subscriptions.id,
    sourceType: subscriptions.sourceType,
    sourceId: subscriptions.sourceId,
    sessionId: subscriptions.sessionId,
    sessionName: subscriptions.sessionName,
  })
  .from(subscriptions)
  .where(
    and(
      eq(subscriptions.calendarToken, subToken),
      eq(subscriptions.userId, user.id),
    ),
  )
  .limit(1);
```

**Step 5: Optimize GET /:sub_token/calendar.ics**

At line 280-284, replace `.select()`:

```typescript
const [sub] = await db
  .select({ icsContent: subscriptions.icsContent })
  .from(subscriptions)
  .where(eq(subscriptions.calendarToken, subToken))
  .limit(1);
```

**Step 6: Optimize getSubForExport helper**

At line 385-389, replace `.select()`:

```typescript
const [sub] = await db
  .select({
    coursesJson: subscriptions.coursesJson,
    examsJson: subscriptions.examsJson,
    semesterStart: subscriptions.semesterStart,
    sessionName: subscriptions.sessionName,
  })
  .from(subscriptions)
  .where(eq(subscriptions.calendarToken, subToken))
  .limit(1);
```

Also update the `getSubForExport` return type annotation from `Promise<Subscription | Response>` to match the narrower select shape. Similarly update `parseSubJson` parameter type from `Subscription` to the narrower type. Use an inline type or define a small type alias:

```typescript
type ExportSub = Pick<Subscription, 'coursesJson' | 'examsJson' | 'semesterStart' | 'sessionName'>;

function parseSubJson(sub: ExportSub): { courses: any[] | null; exams: any[] | null } | null {
  // ... same body
}

async function getSubForExport(c: any): Promise<ExportSub | Response> {
  // ... same body with narrower select
}
```

**Step 7: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run src/`
Expected: All pass

**Step 8: Commit**

```bash
git add src/routes/subscriptions.ts
git commit -m "perf(subscriptions): use column-specific D1 selects (#27)"
```

---

### Task 3: Users routes — column-specific selects

**Files:**
- Modify: `src/routes/users.ts`

**Step 1: Optimize POST / (register) — existing user check**

At line 89-93, replace `.select()`:

```typescript
const [existing] = await db
  .select({ id: users.id, calendarToken: users.calendarToken })
  .from(users)
  .where(eq(users.studentId, body.student_id))
  .limit(1);
```

**Step 2: Optimize POST /recover — user lookup**

At line 221-225, replace `.select()`:

```typescript
const [user] = await db
  .select({
    encryptedPassword: users.encryptedPassword,
    calendarToken: users.calendarToken,
  })
  .from(users)
  .where(eq(users.studentId, body.student_id))
  .limit(1);
```

**Step 3: Optimize POST /recover/verify — user lookup**

At line 281-285, replace `.select()`:

```typescript
const [user] = await db
  .select({ id: users.id, calendarToken: users.calendarToken })
  .from(users)
  .where(eq(users.studentId, body.student_id))
  .limit(1);
```

**Step 4: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run src/`
Expected: All pass

**Step 5: Commit**

```bash
git add src/routes/users.ts
git commit -m "perf(users): use column-specific D1 selects (#27)"
```

---

### Task 4: Cron consumers — column-specific selects

**Files:**
- Modify: `src/cron/schedule-sync.ts`
- Modify: `src/cron/token-refresh.ts`

**Step 1: Optimize schedule-sync consumer — user lookup**

At `schedule-sync.ts:65-68`, replace `.select()`:

```typescript
const [user] = await db
  .select({
    id: users.id,
    studentId: users.studentId,
    accessToken: users.accessToken,
    refreshToken: users.refreshToken,
    encryptedPassword: users.encryptedPassword,
    tokenExpiresAt: users.tokenExpiresAt,
  })
  .from(users)
  .where(eq(users.id, userId));
```

Note: `user.studentId` is used at line 99 and 108. `user.accessToken` at line 85. No other fields used.

**Step 2: Optimize schedule-sync consumer — user subscriptions lookup**

At `schedule-sync.ts:75-78`, replace `.select()`:

```typescript
const userSubs = await db
  .select({
    id: subscriptions.id,
    sourceType: subscriptions.sourceType,
    sourceId: subscriptions.sourceId,
    sourceName: subscriptions.sourceName,
    sessionId: subscriptions.sessionId,
    sessionName: subscriptions.sessionName,
  })
  .from(subscriptions)
  .where(eq(subscriptions.userId, userId));
```

Note: `sub.sourceName` is used at line 124/129 for logging.

**Step 3: Optimize token-refresh consumer — user lookup**

At `token-refresh.ts:58-61`, replace `.select()`:

```typescript
const [user] = await db
  .select({
    id: users.id,
    studentId: users.studentId,
    refreshToken: users.refreshToken,
    encryptedPassword: users.encryptedPassword,
    tokenExpiresAt: users.tokenExpiresAt,
  })
  .from(users)
  .where(eq(users.id, userId));
```

Note: does NOT need `accessToken` (only writes it, never reads). Needs `studentId` for `login()` at line 106.

**Step 4: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run src/`
Expected: All pass

**Step 5: Commit**

```bash
git add src/cron/schedule-sync.ts src/cron/token-refresh.ts
git commit -m "perf(cron): use column-specific D1 selects in queue consumers (#27)"
```

---

### Task 5: Final verification

**Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 2: Full test suite**

Run: `npx vitest run src/`
Expected: All tests pass (same count as before, no regressions)

**Step 3: Verify no remaining `.select()` without columns**

Run: `grep -n '\.select()' src/**/*.ts`
Expected: Only the two already-optimized producers (`schedule-sync.ts:28-29`, `token-refresh.ts:19-20`) which already use column-specific selects. Zero bare `.select()` calls remaining.
