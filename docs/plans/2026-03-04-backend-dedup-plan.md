# Backend Code Deduplication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract 7 duplicated patterns in backend code into shared utilities, reducing maintenance burden and inconsistency risk.

**Architecture:** Extract utility functions into `src/utils/`, refactor callers to use shared code. Pure refactoring — no behavior changes. All existing tests must continue passing.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Drizzle ORM, vitest v3

---

### Task 1: Extract `bufferToBase64` to `src/utils/encoding.ts`

**Files:**
- Create: `src/utils/encoding.ts`
- Create: `src/utils/encoding.test.ts`
- Modify: `src/services/crypto.ts`
- Modify: `src/utils/token.ts`
- Modify: `src/services/ics.ts`

**Step 1: Write the test**

```typescript
// src/utils/encoding.test.ts
import { describe, it, expect } from "vitest";
import { bufferToBase64 } from "./encoding";

describe("bufferToBase64", () => {
  it("encodes an ArrayBuffer to base64", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(bufferToBase64(bytes.buffer)).toBe(btoa("Hello"));
  });

  it("returns empty string for empty buffer", () => {
    expect(bufferToBase64(new ArrayBuffer(0))).toBe("");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/encoding.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/utils/encoding.ts
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/encoding.test.ts`
Expected: PASS

**Step 5: Refactor callers**

In `src/services/crypto.ts`:
- Delete the private `bufferToBase64` function (lines 12-19)
- Add `import { bufferToBase64 } from "../utils/encoding";` at top

In `src/utils/token.ts`:
- Replace inline base64 logic (lines 4-7) with import and call:
```typescript
import { bufferToBase64 } from "./encoding";

export function generateToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return bufferToBase64(bytes.buffer)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
```

In `src/services/ics.ts`:
- Add `import { bufferToBase64 } from "../utils/encoding";` at top
- Replace inline base64 logic in `generateUid` (lines 44-49) with:
```typescript
async function generateUid(
  username: string,
  summary: string,
  start: string,
  end: string,
): Promise<string> {
  const source = `${username},${summary},${start},${end}`;
  const encoded = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToBase64(hash);
}
```

**Step 6: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All tests PASS (crypto, token, ics tests validate behavior unchanged)

**Step 7: Commit**

```
refactor: extract bufferToBase64 to shared utils/encoding module
```

---

### Task 2: Unify `CHINA_TZ_OFFSET_MS` import in ics.ts

**Files:**
- Modify: `src/services/ics.ts`

**Step 1: Remove local constant, add import**

In `src/services/ics.ts`:
- Delete line 3: `const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;`
- Add to existing imports from cqu-api (or add new import line):
```typescript
import { CHINA_TZ_OFFSET_MS } from "../utils/time";
```

**Step 2: Run tests**

Run: `npx vitest run src/services/ics.test.ts`
Expected: All PASS

**Step 3: Commit**

```
refactor: use shared CHINA_TZ_OFFSET_MS in ics service
```

---

### Task 3: Make `OAUTH_BASIC_AUTH` dynamic in auth.ts

**Files:**
- Modify: `src/services/auth.ts`

**Step 1: Replace hardcoded constant**

In `src/services/auth.ts` line 149, replace:
```typescript
const OAUTH_BASIC_AUTH = "cGVyc29uYWwtcHJvZDphcHAtYS0xMjM0";
```
with:
```typescript
const OAUTH_BASIC_AUTH = btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`);
```

**Step 2: Run tests**

Run: `npx vitest run src/services/auth.test.ts`
Expected: All PASS (the value is identical, just derived dynamically now)

**Step 3: Commit**

```
refactor: derive OAUTH_BASIC_AUTH from client credentials
```

---

### Task 4: Extract `calculateCourseEventTime` to `src/utils/time.ts`

**Files:**
- Modify: `src/utils/time.ts`
- Create: `src/utils/time.test.ts`
- Modify: `src/services/ics.ts`
- Modify: `src/services/export.ts`

**Step 1: Write the test**

```typescript
// src/utils/time.test.ts
import { describe, it, expect } from "vitest";
import { calculateCourseEventTime, CHINA_TZ_OFFSET_MS } from "./time";

describe("calculateCourseEventTime", () => {
  // 2025-02-24 is a Monday (week 1, day 1)
  const termStart = new Date("2025-02-24T00:00:00Z");

  it("returns correct UTC time for week 1, Monday, 08:30:00", () => {
    const result = calculateCourseEventTime(termStart, 1, 1, "08:30:00");
    // China 08:30 = UTC 00:30
    expect(result.toISOString()).toBe("2025-02-24T00:30:00.000Z");
  });

  it("returns correct UTC time for week 2, Wednesday, 14:00:00", () => {
    // week 2 wednesday = 7 + 2 = 9 days after term start
    const result = calculateCourseEventTime(termStart, 2, 3, "14:00:00");
    // 2025-03-05 China 14:00 = UTC 06:00
    expect(result.toISOString()).toBe("2025-03-05T06:00:00.000Z");
  });

  it("returns correct UTC time for week 1, Friday, 22:00:00", () => {
    const result = calculateCourseEventTime(termStart, 1, 5, "22:00:00");
    // Feb 28, China 22:00 = UTC 14:00
    expect(result.toISOString()).toBe("2025-02-28T14:00:00.000Z");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/time.test.ts`
Expected: FAIL — function not found

**Step 3: Write implementation**

Append to `src/utils/time.ts`:

```typescript
/**
 * Calculate the UTC Date for a course event given term start, week, day, and time string.
 * @param termStart - The first day of the semester (UTC midnight)
 * @param week - Week number (1-based)
 * @param dayOfWeek - Day of week (1=Monday, 7=Sunday)
 * @param timeStr - Time in "HH:MM:SS" format (China local time)
 */
export function calculateCourseEventTime(
  termStart: Date,
  week: number,
  dayOfWeek: number,
  timeStr: string,
): Date {
  const daysSinceStart = (week - 1) * 7 + (dayOfWeek - 1);
  const eventDateMs =
    termStart.getTime() + daysSinceStart * 24 * 60 * 60 * 1000;
  const eventDate = new Date(eventDateMs);

  const [h, m, s] = timeStr.split(":").map(Number);

  const chinaMs =
    Date.UTC(
      eventDate.getUTCFullYear(),
      eventDate.getUTCMonth(),
      eventDate.getUTCDate(),
      h,
      m,
      s,
    ) - CHINA_TZ_OFFSET_MS;

  return new Date(chinaMs);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/time.test.ts`
Expected: PASS

**Step 5: Refactor `src/services/ics.ts`**

Replace the private `calculateEventTime` function with a call to the shared one:

```typescript
import { CHINA_TZ_OFFSET_MS, calculateCourseEventTime } from "../utils/time";
```

Delete the entire `calculateEventTime` function (lines 52-82). Update callers in `generateCoursesIcs`:

```typescript
// Replace lines 101-114:
const startTime = calculateCourseEventTime(
  termStart,
  week,
  course.day_of_week,
  TIME_SLOTS[course.start_session - 1][0],
);
const endTime = calculateCourseEventTime(
  termStart,
  week,
  course.day_of_week,
  TIME_SLOTS[course.end_session - 1][1],
);
```

**Step 6: Refactor `src/services/export.ts`**

Add import:
```typescript
import { CHINA_TZ_OFFSET_MS, formatChinaIso, calculateCourseEventTime } from "../utils/time";
```

Replace the inline time calculation in `generateFormattedEvents` (lines 70-86):

```typescript
for (const week of weeks) {
  const startDate = calculateCourseEventTime(termStart, week, dayOfWeek, startTimeStr);
  const endDate = calculateCourseEventTime(termStart, week, dayOfWeek, endTimeStr);

  events.push({
    name,
    type: "course",
    instructor,
    location,
    day_of_week: dayOfWeek,
    start_time: formatChinaIso(startDate),
    end_time: formatChinaIso(endDate),
    week,
  });
}
```

**Step 7: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All PASS (ics and export tests validate behavior unchanged)

**Step 8: Commit**

```
refactor: extract calculateCourseEventTime to shared utils/time
```

---

### Task 5: Extract `spreadEnqueue` to `src/utils/queue.ts`

**Files:**
- Create: `src/utils/queue.ts`
- Create: `src/utils/queue.test.ts`
- Modify: `src/cron/token-refresh.ts`
- Modify: `src/cron/schedule-sync.ts`

**Step 1: Write the test**

```typescript
// src/utils/queue.test.ts
import { describe, it, expect, vi } from "vitest";
import { spreadEnqueue } from "./queue";

function createMockQueue() {
  return { sendBatch: vi.fn().mockResolvedValue(undefined) } as any;
}

describe("spreadEnqueue", () => {
  it("does nothing for empty items", async () => {
    const queue = createMockQueue();
    await spreadEnqueue(queue, [], (item) => item, 3600);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it("sends a single batch for <=100 items", async () => {
    const queue = createMockQueue();
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `u${i}` }));
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3600);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(queue.sendBatch.mock.calls[0][0]).toHaveLength(3);
  });

  it("splits into multiple batches for >100 items", async () => {
    const queue = createMockQueue();
    const items = Array.from({ length: 150 }, (_, i) => i);
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3600);
    expect(queue.sendBatch).toHaveBeenCalledTimes(2);
    expect(queue.sendBatch.mock.calls[0][0]).toHaveLength(100);
    expect(queue.sendBatch.mock.calls[1][0]).toHaveLength(50);
  });

  it("applies correct delay spreading", async () => {
    const queue = createMockQueue();
    const items = [0, 1, 2];
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3600);
    const messages = queue.sendBatch.mock.calls[0][0];
    // interval = max(5, floor(3600/3)) = 1200
    expect(messages[0].delaySeconds).toBe(0);
    expect(messages[1].delaySeconds).toBe(1200);
    expect(messages[2].delaySeconds).toBe(2400);
  });

  it("clamps delay to 43200 seconds", async () => {
    const queue = createMockQueue();
    const items = [0, 1];
    // spreadSeconds=1, minInterval=50000 → interval=50000, delay[1]=50000 → clamped to 43200
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 1, 50000);
    const messages = queue.sendBatch.mock.calls[0][0];
    expect(messages[1].delaySeconds).toBe(43200);
  });

  it("respects custom minInterval", async () => {
    const queue = createMockQueue();
    // 3 items, spreadSeconds=3 → floor(3/3)=1, but minInterval=10 → interval=10
    const items = [0, 1, 2];
    await spreadEnqueue(queue, items, (item) => ({ body: item }), 3, 10);
    const messages = queue.sendBatch.mock.calls[0][0];
    expect(messages[1].delaySeconds).toBe(10);
    expect(messages[2].delaySeconds).toBe(20);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/queue.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/utils/queue.ts
const BATCH_SIZE = 100;
const MAX_DELAY_SECONDS = 43200;

/**
 * Enqueue items to a Cloudflare Queue with spread delays.
 * @param queue - The Cloudflare Queue to send to
 * @param items - Array of items to enqueue
 * @param mapFn - Function to transform each item into a queue message body
 * @param spreadSeconds - Total time window to spread messages over (seconds)
 * @param minInterval - Minimum seconds between each message delivery (default: 5)
 */
export async function spreadEnqueue<TItem, TBody>(
  queue: Queue<TBody>,
  items: TItem[],
  mapFn: (item: TItem) => { body: TBody },
  spreadSeconds: number,
  minInterval: number = 5,
): Promise<void> {
  if (items.length === 0) return;

  const interval = Math.max(minInterval, Math.floor(spreadSeconds / items.length));

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    await queue.sendBatch(
      chunk.map((item, j) => ({
        ...mapFn(item),
        delaySeconds: Math.min((i + j) * interval, MAX_DELAY_SECONDS),
      })),
    );
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/queue.test.ts`
Expected: PASS

**Step 5: Refactor `src/cron/token-refresh.ts`**

Add import: `import { spreadEnqueue } from "../utils/queue";`

Replace lines 30-42 in `enqueueTokenRefresh`:
```typescript
await spreadEnqueue(
  env.TOKEN_REFRESH_QUEUE,
  expiring,
  (u) => ({ body: { userId: u.id, studentId: u.studentId } satisfies TokenRefreshMessage }),
  3600,
  5,
);
```

**Step 6: Refactor `src/cron/schedule-sync.ts`**

Add import: `import { spreadEnqueue } from "../utils/queue";`

Replace lines 38-50 in `enqueueScheduleSync`:
```typescript
await spreadEnqueue(
  env.SCHEDULE_SYNC_QUEUE,
  activeUsers,
  (u) => ({ body: { userId: u.id, studentId: u.studentId } satisfies ScheduleSyncMessage }),
  21600,
  10,
);
```

**Step 7: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All PASS (token-refresh and schedule-sync tests validate behavior unchanged)

**Step 8: Commit**

```
refactor: extract spreadEnqueue to shared utils/queue module
```

---

### Task 6: Extract `handleCquApiError` to `src/utils/error.ts`

**Files:**
- Create: `src/utils/error.ts`
- Create: `src/utils/error.test.ts`
- Modify: `src/routes/subscriptions.ts`
- Modify: `src/routes/explore.ts`

**Step 1: Write the test**

```typescript
// src/utils/error.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { handleCquApiError } from "./error";
import { CQUAPIError } from "../services/cqu-api";

describe("handleCquApiError", () => {
  function createContext() {
    const app = new Hono();
    let response: Response;
    app.get("/test", (c) => {
      response = handleCquApiError(c, testError, "Fallback message");
      return response;
    });
    return { app, getResponse: () => response };
  }

  let testError: unknown;

  it("returns 401 for CQUAPIError with statusCode 401", async () => {
    testError = new CQUAPIError("Token expired", 401);
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, testError, "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.detail).toBe("CQU token expired, please re-login");
  });

  it("returns 502 for CQUAPIError with non-401 status", async () => {
    testError = new CQUAPIError("Server error", 500);
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, testError, "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Server error");
  });

  it("returns 502 with fallback message for non-CQUAPIError", async () => {
    testError = new Error("random error");
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, testError, "Fallback message"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.detail).toBe("Fallback message");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/error.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/utils/error.ts
import type { Context } from "hono";
import { CQUAPIError } from "../services/cqu-api";

export function handleCquApiError(
  c: Context,
  e: unknown,
  fallbackMsg: string,
): Response {
  if (e instanceof CQUAPIError) {
    if (e.statusCode === 401) {
      return c.json({ detail: "CQU token expired, please re-login" }, 401);
    }
    return c.json({ detail: e.message }, 502);
  }
  return c.json({ detail: fallbackMsg }, 502);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/error.test.ts`
Expected: PASS

**Step 5: Refactor `src/routes/subscriptions.ts`**

Add import: `import { handleCquApiError } from "../utils/error";`

Replace the catch block in POST `/` (lines 197-205):
```typescript
} catch (e) {
  return handleCquApiError(c, e, "Failed to fetch schedule");
}
```

Replace the catch block in POST `/:sub_token/refresh` (lines 285-293):
```typescript
} catch (e) {
  return handleCquApiError(c, e, "Refresh failed");
}
```

**Step 6: Refactor `src/routes/explore.ts`**

Add import: `import { handleCquApiError } from "../utils/error";`

Replace the catch block in GET `/search` (lines 61-69):
```typescript
} catch (e) {
  return handleCquApiError(c, e, "Search failed");
}
```

Also replace the catch block in GET `/departments` (lines 81-86):
```typescript
} catch (e) {
  return handleCquApiError(c, e, "Failed to load departments");
}
```

**Step 7: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All PASS

**Step 8: Commit**

```
refactor: extract handleCquApiError to shared utils/error module
```

---

### Task 7: Extract credential parsing helpers in `src/routes/users.ts`

**Files:**
- Modify: `src/routes/users.ts`

**Step 1: Add helper functions at top of `users.ts`**

After imports and before routes, add:

```typescript
import type { Context } from "hono";

const STUDENT_ID_PATTERN = /^\d{8}$|^\d{17}[\dX]$/;

async function requireCaptcha(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
    return null;
  } catch (e) {
    if (e instanceof CaptchaError) {
      return c.json({ detail: e.message }, 403);
    }
    throw e;
  }
}

async function parseCredentials(
  c: Context,
): Promise<{ student_id: string; password: string } | Response> {
  let body: { student_id: string; password: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ detail: "Invalid JSON body" }, 400);
  }
  if (!body.student_id || !body.password) {
    return c.json({ detail: "student_id and password required" }, 400);
  }
  if (!STUDENT_ID_PATTERN.test(body.student_id)) {
    return c.json(
      { detail: "student_id must be 8-digit number or 18-digit ID card number" },
      400,
    );
  }
  if (body.password.length > 256) {
    return c.json(
      { detail: "password must not exceed 256 characters" },
      400,
    );
  }
  return body;
}
```

**Step 2: Refactor POST `/` (register) — lines 39-70**

Replace with:
```typescript
app.post("/", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaErr = await requireCaptcha(c);
  if (captchaErr) return captchaErr;
  const result = await parseCredentials(c);
  if (result instanceof Response) return result;
  const { student_id, password } = result;

  const db = drizzle(c.env.DB);
  // ... rest of handler unchanged, using student_id and password ...
```

**Step 3: Refactor POST `/recover` — lines 187-218**

Replace with:
```typescript
app.post("/recover", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaErr = await requireCaptcha(c);
  if (captchaErr) return captchaErr;
  const result = await parseCredentials(c);
  if (result instanceof Response) return result;
  const { student_id, password } = result;

  const db = drizzle(c.env.DB);
  // ... rest unchanged, replace body.student_id → student_id, body.password → password ...
```

**Step 4: Refactor POST `/recover/verify` — lines 241-272**

Replace with:
```typescript
app.post("/recover/verify", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const captchaErr = await requireCaptcha(c);
  if (captchaErr) return captchaErr;
  const result = await parseCredentials(c);
  if (result instanceof Response) return result;
  const { student_id, password } = result;

  const db = drizzle(c.env.DB);
  // ... rest unchanged, replace body.student_id → student_id, body.password → password ...
```

**Step 5: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All PASS — validation.test.ts covers all edge cases for these 3 endpoints

**Step 6: Commit**

```
refactor: extract credential parsing helpers in users routes
```

---

### Task 8: Final verification and PR

**Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 2: Run full test suite**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All tests PASS

**Step 3: Review changes**

Run: `git diff --stat main`
Verify:
- New files: `src/utils/encoding.ts`, `src/utils/encoding.test.ts`, `src/utils/queue.ts`, `src/utils/queue.test.ts`, `src/utils/error.ts`, `src/utils/error.test.ts`, `src/utils/time.test.ts`
- Modified: `src/services/crypto.ts`, `src/services/ics.ts`, `src/services/export.ts`, `src/services/auth.ts`, `src/utils/token.ts`, `src/utils/time.ts`, `src/routes/users.ts`, `src/routes/subscriptions.ts`, `src/routes/explore.ts`, `src/cron/token-refresh.ts`, `src/cron/schedule-sync.ts`

**Step 4: Create PR**

```bash
gh pr create --title "refactor: extract shared backend utilities (#24)" \
  --body "Closes #24"
```
