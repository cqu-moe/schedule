# Standardize Error Response Format — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify all API error responses to `{ detail: { error: { code, message } } }` format (issue #31).

**Architecture:** Extract shared `errorResponse()` to `src/utils/error.ts`, update all routes/middleware to use it, simplify frontend `parseApiError()` to handle only the structured format.

**Tech Stack:** Hono, Vitest (workerd pool for backend, jsdom for frontend), Vue 3

---

### Task 1: Add shared `errorResponse()` and update `handleCquApiError()`

**Files:**
- Modify: `src/utils/error.ts`
- Test: `src/utils/error.test.ts`

**Step 1: Update `src/utils/error.ts`**

Add the `errorResponse` function and update `handleCquApiError` to use it:

```typescript
import { CQUAPIError } from "../services/cqu-api";

export function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { detail: { error: { code, message } } },
    { status },
  );
}

export function handleCquApiError(
  _c: unknown,
  e: unknown,
  fallbackMsg: string,
): Response {
  if (e instanceof CQUAPIError) {
    if (e.statusCode === 401) {
      return errorResponse("TOKEN_EXPIRED", "CQU token expired, please re-login", 401);
    }
    return errorResponse("UPSTREAM_ERROR", e.message, 502);
  }
  return errorResponse("UPSTREAM_ERROR", fallbackMsg, 502);
}
```

Note: `handleCquApiError` no longer needs `Context` — change first param to `_c: unknown` (callers still pass `c` but it's unused). The `c` parameter is kept for backward compat at call sites.

**Step 2: Update `src/utils/error.test.ts`**

Update all assertions from `{ detail: "..." }` to `{ detail: { error: { code, message } } }`:

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { handleCquApiError, errorResponse } from "./error";
import { CQUAPIError } from "../services/cqu-api";

describe("errorResponse", () => {
  it("returns structured error JSON", async () => {
    const res = errorResponse("BAD_REQUEST", "Invalid input", 400);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: { error: { code: "BAD_REQUEST", message: "Invalid input" } },
    });
  });
});

describe("handleCquApiError", () => {
  it("returns 401 TOKEN_EXPIRED for CQUAPIError with statusCode 401", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new CQUAPIError("expired", 401), "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: { code: "TOKEN_EXPIRED", message: "CQU token expired, please re-login" } },
    });
  });

  it("returns 502 UPSTREAM_ERROR for CQUAPIError with non-401 status", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new CQUAPIError("Server error", 500), "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      detail: { error: { code: "UPSTREAM_ERROR", message: "Server error" } },
    });
  });

  it("returns 502 UPSTREAM_ERROR with fallback for non-CQUAPIError", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new Error("random"), "Fallback message"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      detail: { error: { code: "UPSTREAM_ERROR", message: "Fallback message" } },
    });
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/utils/error.test.ts`
Expected: PASS

**Step 4: Commit**

```
git add src/utils/error.ts src/utils/error.test.ts
git commit -m "refactor: add shared errorResponse() and update handleCquApiError"
```

---

### Task 2: Update middleware (auth + rate-limit)

**Files:**
- Modify: `src/middleware/auth.ts`
- Modify: `src/middleware/rate-limit.ts`

**Step 1: Update `src/middleware/auth.ts`**

Import `errorResponse` and replace all `c.json({ detail: "..." }, status)` calls:

- Line 16: `c.json({ detail: "Invalid authorization header" }, 401)` → `errorResponse("UNAUTHORIZED", "Invalid authorization header", 401)`
- Line 42: `c.json({ detail: "Invalid token" }, 401)` → `errorResponse("UNAUTHORIZED", "Invalid token", 401)`
- Line 71: `c.json({ detail: "Invalid token" }, 401)` → `errorResponse("UNAUTHORIZED", "Invalid token", 401)`
- Line 75: `c.json({ detail: "CQU token expired, please re-login" }, 401)` → `errorResponse("TOKEN_EXPIRED", "CQU token expired, please re-login", 401)`

Add import at top:
```typescript
import { errorResponse } from "../utils/error";
```

**Step 2: Update `src/middleware/rate-limit.ts`**

- Line 12: `c.json({ detail: "Rate limit exceeded" }, 429)` → `errorResponse("RATE_LIMITED", "Rate limit exceeded", 429)`

Add import at top:
```typescript
import { errorResponse } from "../utils/error";
```

**Step 3: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: PASS (middleware is tested indirectly through route tests; auth/rate-limit tests that check `detail` string need updating — see Task 5)

**Step 4: Commit**

```
git add src/middleware/auth.ts src/middleware/rate-limit.ts
git commit -m "refactor: use errorResponse() in auth and rate-limit middleware"
```

---

### Task 3: Update `src/routes/users.ts`

**Files:**
- Modify: `src/routes/users.ts`

**Step 1: Update imports and remove local `errorResponse()`**

Remove lines 25-30 (local `errorResponse` function). Add import:
```typescript
import { errorResponse } from "../utils/error";
```

**Step 2: Update `requireCaptcha` helper (line 46)**

CaptchaError.message is already the code string (`"CAPTCHA_REQUIRED"`, `"CAPTCHA_FAILED"`, `"CAPTCHA_SERVICE_UNAVAILABLE"`). Use it as the code:

```typescript
if (e instanceof CaptchaError) {
  return errorResponse(e.message, e.message, 403);
}
```

**Step 3: Update `parseCredentials` helper (lines 59-74)**

Replace all `c.json({ detail: "..." }, 400)`:

```typescript
// line 59
return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
// line 62
return errorResponse("BAD_REQUEST", "student_id and password required", 400);
// line 65-68
return errorResponse("BAD_REQUEST", "student_id must be 8-digit number or 18-digit ID card number", 400);
// line 71-73
return errorResponse("BAD_REQUEST", "password must not exceed 256 characters", 400);
```

**Step 4: Run tests**

Run: `npx vitest run src/routes/validation.test.ts`
Expected: FAIL — tests check `body.detail` as string, now it's an object. Fix in Task 5.

**Step 5: Commit**

```
git add src/routes/users.ts
git commit -m "refactor: use shared errorResponse() in users route"
```

---

### Task 4: Update `src/routes/subscriptions.ts`, `src/routes/explore.ts`, `src/index.ts`

**Files:**
- Modify: `src/routes/subscriptions.ts`
- Modify: `src/routes/explore.ts`
- Modify: `src/index.ts`

**Step 1: Update `src/routes/subscriptions.ts`**

Add import:
```typescript
import { handleCquApiError, errorResponse } from "../utils/error";
```

Replace each `c.json({ detail: "..." }, status)`:

| Line | Old | New |
|------|-----|-----|
| 77 | `c.json({ detail: e.message }, 403)` | `errorResponse(e.message, e.message, 403)` |
| 85 | `c.json({ detail: "Invalid JSON body" }, 400)` | `errorResponse("BAD_REQUEST", "Invalid JSON body", 400)` |
| 88 | `c.json({ detail: "source_id and source_name required" }, 400)` | `errorResponse("BAD_REQUEST", "source_id and source_name required", 400)` |
| 92 | `c.json({ detail: "source_id must not exceed 100 characters" }, 400)` | `errorResponse("BAD_REQUEST", "source_id must not exceed 100 characters", 400)` |
| 98 | `c.json({ detail: "source_name must not exceed 200 characters" }, 400)` | `errorResponse("BAD_REQUEST", "source_name must not exceed 200 characters", 400)` |
| 111 | `c.json({ detail: "Invalid source_type" }, 400)` | `errorResponse("BAD_REQUEST", "Invalid source_type", 400)` |
| 130 | `c.json({ detail: \`Maximum subscriptions (${maxSubs}) reached\` }, 409)` | `errorResponse("MAX_SUBSCRIPTIONS", \`Maximum subscriptions (${maxSubs}) reached\`, 409)` |
| 152 | `c.json({ detail: "Subscription already exists for this session" }, 409)` | `errorResponse("SUBSCRIPTION_DUPLICATE", "Subscription already exists for this session", 409)` |
| 223 | `c.json({ detail: "Subscription not found" }, 404)` | `errorResponse("NOT_FOUND", "Subscription not found", 404)` |
| 225 | `c.json({ detail: "Cannot delete personal subscriptions" }, 403)` | `errorResponse("FORBIDDEN", "Cannot delete personal subscriptions", 403)` |
| 254 | `c.json({ detail: "Subscription not found" }, 404)` | `errorResponse("NOT_FOUND", "Subscription not found", 404)` |
| 299 | `c.json({ detail: "Subscription not found or no data" }, 404)` | `errorResponse("NOT_FOUND", "Subscription not found or no data", 404)` |
| 317 | `c.json({ detail: "Stored data is corrupted" }, 500)` | `errorResponse("DATA_CORRUPTED", "Stored data is corrupted", 500)` |
| 337 | `c.json({ detail: "Stored data is corrupted" }, 500)` | `errorResponse("DATA_CORRUPTED", "Stored data is corrupted", 500)` |
| 365 | `c.json({ detail: "Stored data is corrupted" }, 500)` | `errorResponse("DATA_CORRUPTED", "Stored data is corrupted", 500)` |
| 411 | `c.json({ detail: "Subscription not found or no data" }, 404)` | `errorResponse("NOT_FOUND", "Subscription not found or no data", 404)` |

Note: `FORBIDDEN` is a new code for "Cannot delete personal subscriptions". Add it to the design doc's code list if needed.

**Step 2: Update `src/routes/explore.ts`**

Add import:
```typescript
import { handleCquApiError, errorResponse } from "../utils/error";
```

| Line | Old | New |
|------|-----|-----|
| 18 | `c.json({ detail: "keyword is required" }, 400)` | `errorResponse("BAD_REQUEST", "keyword is required", 400)` |
| 21 | `c.json({ detail: "keyword must not exceed 100 characters" }, 400)` | `errorResponse("BAD_REQUEST", "keyword must not exceed 100 characters", 400)` |
| 59 | `c.json({ detail: "Invalid source_type" }, 400)` | `errorResponse("BAD_REQUEST", "Invalid source_type", 400)` |

**Step 3: Update `src/index.ts`**

Add import:
```typescript
import { errorResponse } from "./utils/error";
```

Line 45: `c.json({ detail: "Internal server error" }, 500)` → `errorResponse("INTERNAL_ERROR", "Internal server error", 500)`

**Step 4: Commit**

```
git add src/routes/subscriptions.ts src/routes/explore.ts src/index.ts
git commit -m "refactor: use errorResponse() in subscriptions, explore routes and global handler"
```

---

### Task 5: Update backend tests

**Files:**
- Modify: `src/routes/validation.test.ts`
- Modify: `src/routes/explore.test.ts`

**Step 1: Update `src/routes/validation.test.ts`**

All assertions that check `body.detail` as a string need updating. The pattern is:

Old: `expect(body.detail).toContain("student_id")`
New: `expect(body.detail.error.message).toContain("student_id")`

Specific changes:
- Line 55: `expect(body.detail).toContain("student_id")` → `expect(body.detail.error.message).toContain("student_id")`
- Line 62: `expect(body.detail).toContain("password")` → `expect(body.detail.error.message).toContain("password")`
- Line 75: `expect(body.detail).toContain("student_id")` → `expect(body.detail.error.message).toContain("student_id")`
- Line 132: `expect(body.detail).toContain("256")` → `expect(body.detail.error.message).toContain("256")`
- Line 164: `expect(body.detail).toContain("JSON")` → `expect(body.detail.error.message).toContain("JSON")`

Also verify that all `body.detail.error.code` is `"BAD_REQUEST"` for these validation errors.

**Step 2: Update `src/routes/explore.test.ts`**

- Line 29: `expect(body.detail).toContain("keyword")` → `expect(body.detail.error.message).toContain("keyword")`
- Line 36: `expect(body.detail).toContain("keyword")` → `expect(body.detail.error.message).toContain("keyword")`
- Line 43: `expect(body.detail).toContain("keyword")` → `expect(body.detail.error.message).toContain("keyword")`

**Step 3: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: ALL PASS

**Step 4: Commit**

```
git add src/routes/validation.test.ts src/routes/explore.test.ts
git commit -m "test: update backend tests for structured error format"
```

---

### Task 6: Update frontend `parseApiError()` and interceptor

**Files:**
- Modify: `frontend/src/utils/error.ts`
- Modify: `frontend/src/api/index.js`

**Step 1: Update `frontend/src/utils/error.ts`**

```typescript
const CODE_MESSAGES: Record<string, string> = {
  CAPTCHA_REQUIRED: '验证码验证失败，请刷新页面重试',
  CAPTCHA_FAILED: '验证码验证失败，请刷新页面重试',
  CAPTCHA_SERVICE_UNAVAILABLE: '验证码验证失败，请刷新页面重试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
}

export function parseApiError(error: unknown, fallback = '操作失败'): string {
  const resp = (error as any)?.response
  if (!resp?.data) return fallback

  const detail = resp.data.detail
  if (!detail) return fallback

  const code = detail?.error?.code
  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code]
  }

  return detail?.error?.message ?? fallback
}
```

Key changes:
- Remove string `detail` branch — all errors are now structured
- Add `CAPTCHA_SERVICE_UNAVAILABLE` and `RATE_LIMITED` to `CODE_MESSAGES`

**Step 2: Update `frontend/src/api/index.js`**

Change the 429 interceptor to only provide fallback when no body exists:

```javascript
client.interceptors.response.use(undefined, (error) => {
  if (error.response?.status === 429 && !error.response?.data?.detail) {
    error.response.data = { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } }
  }
  return Promise.reject(error)
})
```

**Step 3: Commit**

```
git add frontend/src/utils/error.ts frontend/src/api/index.js
git commit -m "refactor: simplify parseApiError for unified structured error format"
```

---

### Task 7: Update frontend tests

**Files:**
- Modify: `frontend/src/utils/__tests__/error.test.ts`
- Modify: `frontend/src/api/__tests__/index.test.ts`

**Step 1: Update `frontend/src/utils/__tests__/error.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { parseApiError } from '@/utils/error'

describe('parseApiError', () => {
  it('returns error message from structured error', () => {
    const error = { response: { data: { detail: { error: { code: 'BAD_REQUEST', message: '自定义错误' } } } } }
    expect(parseApiError(error)).toBe('自定义错误')
  })

  it('maps CAPTCHA_REQUIRED code to message', () => {
    const error = { response: { data: { detail: { error: { code: 'CAPTCHA_REQUIRED', message: 'CAPTCHA_REQUIRED' } } } } }
    expect(parseApiError(error)).toBe('验证码验证失败，请刷新页面重试')
  })

  it('maps CAPTCHA_FAILED code to message', () => {
    const error = { response: { data: { detail: { error: { code: 'CAPTCHA_FAILED', message: 'CAPTCHA_FAILED' } } } } }
    expect(parseApiError(error)).toBe('验证码验证失败，请刷新页面重试')
  })

  it('maps RATE_LIMITED code to message', () => {
    const error = { response: { data: { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } } } }
    expect(parseApiError(error)).toBe('操作过于频繁，请稍后再试')
  })

  it('returns fallback when no response', () => {
    expect(parseApiError({}, '网络错误')).toBe('网络错误')
  })

  it('returns fallback when no data', () => {
    expect(parseApiError({ response: {} }, '网络错误')).toBe('网络错误')
  })

  it('returns fallback when no detail', () => {
    expect(parseApiError({ response: { data: {} } }, '请求失败')).toBe('请求失败')
  })

  it('returns default fallback "操作失败" when no fallback provided', () => {
    expect(parseApiError(null)).toBe('操作失败')
  })
})
```

**Step 2: Update `frontend/src/api/__tests__/index.test.ts`**

Update the interceptor test (around line 57-65):

```typescript
it('provides fallback data on 429 error with no body', async () => {
  expect(interceptorErrorHandler).toBeDefined()

  const error = {
    response: { status: 429, data: {} },
  }

  await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
  expect(error.response.data).toEqual({
    detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
  })
})

it('preserves existing body on 429 error', async () => {
  const error = {
    response: {
      status: 429,
      data: { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } },
    },
  }

  await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
  expect(error.response.data).toEqual({
    detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
  })
})

it('passes through non-429 errors unchanged', async () => {
  const error = {
    response: { status: 500, data: { detail: { error: { code: 'INTERNAL_ERROR', message: 'Server error' } } } },
  }

  await expect(interceptorErrorHandler!(error)).rejects.toBe(error)
  expect(error.response.data).toEqual({
    detail: { error: { code: 'INTERNAL_ERROR', message: 'Server error' } },
  })
})
```

**Step 3: Run frontend tests**

Run: `npm run test:frontend`
Expected: ALL PASS

**Step 4: Commit**

```
git add frontend/src/utils/__tests__/error.test.ts frontend/src/api/__tests__/index.test.ts
git commit -m "test: update frontend tests for structured error format"
```

---

### Task 8: Run full test suite and typecheck

**Step 1: Run backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: ALL PASS

**Step 2: Run frontend tests**

Run: `npm run test:frontend`
Expected: ALL PASS

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No new errors

**Step 4: Squash commit if all green**

If any test fails, fix and recommit. Otherwise, done.
