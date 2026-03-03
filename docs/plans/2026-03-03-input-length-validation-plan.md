# Input Length Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add input length/format validation to 3 endpoints to prevent oversized input reaching upstream APIs and D1.

**Architecture:** Add inline `if` checks in existing route handlers, right after JSON parsing / required-field checks. No new dependencies, no new utility files.

**Tech Stack:** Hono route handlers, vitest + @cloudflare/vitest-pool-workers

---

### Task 1: Add student_id and password validation to users.ts

**Files:**
- Modify: `src/routes/users.ts:54-56` (register), `src/routes/users.ts:184-189` (recover), `src/routes/users.ts:220-225` (recover/verify)

**Step 1: Add validation to POST / (register)**

After the existing required-fields check (line 54-56), add:

```typescript
  if (!body.student_id || !body.password) {
    return c.json({ detail: "student_id and password required" }, 400);
  }

  // --- NEW: input validation ---
  const studentIdPattern = /^\d{8}$|^\d{17}[\dX]$/;
  if (!studentIdPattern.test(body.student_id)) {
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
```

**Step 2: Add same validation to POST /recover**

After the JSON parse block (line 184-189), add the same student_id + password validation. Note: `/recover` currently has no required-field check — add one too:

```typescript
  if (!body.student_id || !body.password) {
    return c.json({ detail: "student_id and password required" }, 400);
  }
  const studentIdPattern = /^\d{8}$|^\d{17}[\dX]$/;
  if (!studentIdPattern.test(body.student_id)) {
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
```

**Step 3: Add same validation to POST /recover/verify**

Same pattern, after JSON parse block (line 220-225).

**Step 4: DRY — extract the regex to a module-level constant**

To avoid repeating the regex 3 times, extract it:

```typescript
const STUDENT_ID_PATTERN = /^\d{8}$|^\d{17}[\dX]$/;
```

Each handler references `STUDENT_ID_PATTERN` instead of inline regex.

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no new errors

---

### Task 2: Add keyword validation to explore.ts

**Files:**
- Modify: `src/routes/explore.ts:14-16`

**Step 1: Add keyword length check**

After the query param extraction (line 16), before the switch statement:

```typescript
  const keyword = c.req.query("keyword") ?? "";

  // --- NEW: input validation ---
  if (keyword.length > 100) {
    return c.json(
      { detail: "keyword must not exceed 100 characters" },
      400,
    );
  }
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no new errors

---

### Task 3: Add source_id and source_name validation to subscriptions.ts

**Files:**
- Modify: `src/routes/subscriptions.ts:70-86`

**Step 1: Add required-field + length checks**

After JSON parse (line 70-75), before source_type validation:

```typescript
  if (!body.source_id || !body.source_name) {
    return c.json({ detail: "source_id and source_name required" }, 400);
  }
  if (body.source_id.length > 100) {
    return c.json(
      { detail: "source_id must not exceed 100 characters" },
      400,
    );
  }
  if (body.source_name.length > 200) {
    return c.json(
      { detail: "source_name must not exceed 200 characters" },
      400,
    );
  }
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no new errors

---

### Task 4: Write validation tests

**Files:**
- Create: `src/routes/validation.test.ts`

Test the 3 route sub-apps via Hono's `app.request()` with mock env. Validation failures happen before DB queries or external API calls, so mocks are minimal.

**Step 1: Write test file**

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock external services so handlers don't need real bindings
vi.mock("../services/captcha", () => ({
  verifyCaptcha: vi.fn().mockResolvedValue(undefined),
  CaptchaError: class extends Error {},
}));

vi.mock("../services/auth", () => ({
  login: vi.fn(),
  AuthError: class extends Error {
    code = "";
  },
}));

import usersApp from "./users";
import exploreApp from "./explore";
import subscriptionsApp from "./subscriptions";

// Minimal mock env — only needs rate limiter stubs
// (validation rejects before DB/API calls)
const mockEnv = {
  UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  EXPLORE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  HCAPTCHA_SECRET: "test",
  ENCRYPTION_KEY: "test",
  MAX_SUBSCRIPTIONS: "10",
  PUBLIC_URL: "https://test.example.com",
} as any;

function jsonPost(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── users: student_id validation ────────────────────────────────────

describe("POST /users — student_id validation", () => {
  it("rejects non-numeric student_id", async () => {
    const res = await usersApp.request(
      "/",
      jsonPost("/", { student_id: "abcdefgh", password: "pw" }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "student_id must be 8-digit number or 18-digit ID card number",
    });
  });

  it("rejects too-short student_id", async () => {
    const res = await usersApp.request(
      "/",
      jsonPost("/", { student_id: "1234", password: "pw" }),
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it("accepts 8-digit student_id", async () => {
    // Won't return 400 for student_id — may fail later on login mock,
    // but should NOT be 400 with student_id error
    const res = await usersApp.request(
      "/",
      jsonPost("/", { student_id: "20210001", password: "pw" }),
      mockEnv,
    );
    expect(res.status).not.toBe(400);
  });

  it("accepts 18-digit ID card number", async () => {
    const res = await usersApp.request(
      "/",
      jsonPost("/", { student_id: "11010119900101001X", password: "pw" }),
      mockEnv,
    );
    expect(res.status).not.toBe(400);
  });

  it("rejects password over 256 characters", async () => {
    const res = await usersApp.request(
      "/",
      jsonPost("/", { student_id: "20210001", password: "a".repeat(257) }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "password must not exceed 256 characters",
    });
  });
});

// ── explore: keyword validation ─────────────────────────────────────

describe("GET /search — keyword validation", () => {
  it("rejects keyword over 100 characters", async () => {
    const long = "a".repeat(101);
    const req = new Request(
      `http://localhost/search?source_type=instructor&keyword=${long}`,
    );
    // Need auth header for requireAuthWithCquToken — but validation
    // should run after auth middleware. We skip by testing the sub-app
    // which won't have auth context set, so this might fail on auth first.
    // Alternative: test just that a valid-length keyword doesn't get
    // a 400 for keyword length.
    // Since explore requires auth, we'll verify the validation logic
    // exists by checking the source code and rely on manual testing.
    // Instead, test the boundary:
  });
});

// Note: explore.ts endpoints require auth middleware which is harder to
// mock in sub-app tests. The keyword validation is a single if-check;
// it will be covered by integration testing.

// ── subscriptions: source_id/source_name validation ─────────────────

describe("POST /subscriptions — field validation", () => {
  it("rejects missing source_id", async () => {
    const mockAuthEnv = {
      ...mockEnv,
      // requireAuthWithCquToken needs these:
    } as any;
    // Similar auth middleware challenge as explore.
    // The validation is simple inline if-checks.
  });
});
```

**Important note:** Route-level testing for authenticated endpoints (explore, subscriptions) requires mocking auth middleware which is complex in the workerd vitest pool. Since the validation changes are trivial if-checks, the pragmatic approach is:

- Test **unauthenticated** endpoints (POST /users, POST /recover) via `app.request()` with captcha mocked
- Verify **authenticated** endpoints (GET /search, POST /subscriptions) via typecheck + manual testing
- Add integration tests for authenticated endpoints in a future PR when a test helper for auth is available

**Revised test file** — focus on what's testable without complex mocking:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../services/captcha", () => ({
  verifyCaptcha: vi.fn().mockResolvedValue(undefined),
  CaptchaError: class extends Error {},
}));

vi.mock("../services/auth", () => ({
  login: vi.fn(),
  AuthError: class extends Error {
    code = "";
  },
}));

import usersApp from "./users";

const mockEnv = {
  UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  HCAPTCHA_SECRET: "test",
} as any;

describe("input validation — users", () => {
  function post(body: Record<string, unknown>) {
    return usersApp.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      mockEnv,
    );
  }

  function postRecover(body: Record<string, unknown>) {
    return usersApp.request(
      "/recover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      mockEnv,
    );
  }

  it("rejects invalid student_id format", async () => {
    const res = await post({ student_id: "abc", password: "pw" });
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.detail).toContain("student_id");
  });

  it("accepts valid 8-digit student_id", async () => {
    const res = await post({ student_id: "20210001", password: "pw" });
    // Should pass validation (may fail on login mock — that's fine)
    expect(res.status).not.toBe(400);
  });

  it("accepts valid 18-digit ID card number", async () => {
    const res = await post({
      student_id: "11010119900101001X",
      password: "pw",
    });
    expect(res.status).not.toBe(400);
  });

  it("rejects password over 256 chars", async () => {
    const res = await post({
      student_id: "20210001",
      password: "a".repeat(257),
    });
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.detail).toContain("256");
  });

  it("rejects invalid student_id on /recover", async () => {
    const res = await postRecover({ student_id: "short", password: "pw" });
    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- src/routes/validation.test.ts`
Expected: all PASS

---

### Task 5: Run full test suite and commit

**Step 1: Run all backend tests**

Run: `npm test`
Expected: all existing tests still pass + new validation tests pass

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

**Step 3: Commit**

```bash
git add src/routes/users.ts src/routes/explore.ts src/routes/subscriptions.ts src/routes/validation.test.ts
git commit -m "fix(security): add input length validation (#17)"
```
