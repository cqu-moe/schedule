# Empty Keyword Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reject empty/whitespace-only `keyword` in `GET /api/v1/search` with 400 before hitting upstream CQU API.

**Architecture:** Add a single guard clause in `src/routes/explore.ts` before the existing length check. Test by mocking auth/rate-limit middleware to isolate validation logic.

**Tech Stack:** Hono, vitest v3, @cloudflare/vitest-pool-workers

---

### Task 1: Write the failing test

**Files:**
- Create: `src/routes/explore.test.ts`

**Step 1: Write test file**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth middleware to pass through
vi.mock("../middleware/auth", () => ({
  requireAuth: vi.fn().mockImplementation(() => async (_c: any, next: any) => next()),
  requireAuthWithCquToken: vi.fn().mockImplementation(() => async (_c: any, next: any) => next()),
}));

import exploreApp from "./explore";

const mockEnv = {
  EXPLORE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
} as any;

function get(path: string) {
  return exploreApp.request(path, { method: "GET" }, mockEnv);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.EXPLORE_LIMITER.limit.mockResolvedValue({ success: true });
});

describe("GET /search keyword validation", () => {
  it("rejects empty keyword with 400", async () => {
    const res = await get("/search?source_type=instructor&keyword=");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("keyword");
  });

  it("rejects missing keyword param with 400", async () => {
    const res = await get("/search?source_type=instructor");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("keyword");
  });

  it("rejects whitespace-only keyword with 400", async () => {
    const res = await get("/search?source_type=instructor&keyword=%20%20%20");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("keyword");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/explore.test.ts`
Expected: FAIL — empty keyword currently passes validation and tries to call CQU API (which will error differently, not 400).

**Step 3: Commit failing test**

```bash
git add src/routes/explore.test.ts
git commit -m "test: add failing tests for empty keyword validation (#35)"
```

---

### Task 2: Implement empty keyword guard

**Files:**
- Modify: `src/routes/explore.ts:16-17`

**Step 1: Add the guard clause**

In `src/routes/explore.ts`, after line 16 (`const keyword = ...`), before the existing length check, add:

```typescript
  if (!keyword.trim()) {
    return c.json({ detail: "keyword is required" }, 400);
  }
```

The resulting lines 16-22 should look like:

```typescript
  const keyword = c.req.query("keyword") ?? "";
  if (!keyword.trim()) {
    return c.json({ detail: "keyword is required" }, 400);
  }
  if (keyword.length > 100) {
    return c.json(
      { detail: "keyword must not exceed 100 characters" },
      400,
    );
  }
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/routes/explore.test.ts`
Expected: All 3 tests PASS.

**Step 3: Run full backend test suite**

Run: `npx vitest run src/`
Expected: All existing tests still pass.

**Step 4: Typecheck**

Run: `npm run typecheck`
Expected: No new errors.

**Step 5: Commit**

```bash
git add src/routes/explore.ts
git commit -m "fix(api): validate empty keyword in search endpoint (#35)"
```
