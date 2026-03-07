# Admin Refresh-All Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an admin API endpoint to trigger immediate full schedule sync for all active users.

**Architecture:** New `src/routes/admin.ts` Hono sub-app with Bearer token auth middleware, a single `POST /refresh-all` endpoint that enqueues all active users to the existing `schedule-sync` queue without delay. Shell script for CLI convenience.

**Tech Stack:** Hono, Drizzle ORM, Cloudflare Queues, vitest

---

### Task 1: Add `ADMIN_SECRET` to Env interface

**Files:**
- Modify: `src/types.ts:24` (add after HCAPTCHA_SECRET line)

**Step 1: Add the field**

In `src/types.ts`, add `ADMIN_SECRET: string;` to the Secrets section:

```typescript
  // Secrets
  ENCRYPTION_KEY: string;
  HCAPTCHA_SECRET: string;
  ADMIN_SECRET: string;
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers of ADMIN_SECRET yet)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add ADMIN_SECRET to Env interface"
```

---

### Task 2: Create admin route with auth middleware and refresh-all endpoint

**Files:**
- Create: `src/routes/admin.ts`

**Step 1: Create the admin route module**

```typescript
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { isNotNull } from "drizzle-orm";
import type { Env } from "../types";
import { users } from "../db/schema";
import { errorResponse } from "../utils/error";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";

const BATCH_SIZE = 100;

const app = new Hono<{ Bindings: Env }>();

// Admin auth middleware
app.use("/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${c.env.ADMIN_SECRET}`) {
    return errorResponse("UNAUTHORIZED", "Invalid or missing admin secret", 401);
  }
  await next();
});

// POST /refresh-all
app.post("/refresh-all", async (c) => {
  const db = drizzle(c.env.DB);

  const activeUsers = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: 0, message: "No active users" }));
    return c.json({ enqueued: 0 });
  }

  // Enqueue all users with no delay, batched by 100
  for (let i = 0; i < activeUsers.length; i += BATCH_SIZE) {
    const chunk = activeUsers.slice(i, i + BATCH_SIZE);
    await c.env.SCHEDULE_SYNC_QUEUE.sendBatch(
      chunk.map((u) => ({
        body: { userId: u.id, studentId: u.studentId } satisfies ScheduleSyncMessage,
      })),
    );
  }

  console.log(JSON.stringify({ event: "admin.refresh_all.enqueued", count: activeUsers.length, message: `Enqueued ${activeUsers.length} users for immediate sync` }));
  return c.json({ enqueued: activeUsers.length });
});

export default app;
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: add admin route with refresh-all endpoint"
```

---

### Task 3: Mount admin routes in index.ts

**Files:**
- Modify: `src/index.ts:7-8` (add import), `src/index.ts:42` (add route mount)

**Step 1: Add import and mount**

Add import after the exploreRoutes import:

```typescript
import adminRoutes from "./routes/admin";
```

Add route mount after the explore routes line:

```typescript
app.route("/api/v1/admin", adminRoutes);
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: mount admin routes at /api/v1/admin"
```

---

### Task 4: Write tests for admin route

**Files:**
- Create: `src/routes/admin.test.ts`

The test uses the same pattern as `config.test.ts` — call `app.request()` directly with a mock env. For Queue, use a mock object that tracks `sendBatch` calls.

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi } from "vitest";
import adminApp from "./admin";

function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    },
    SCHEDULE_SYNC_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as any;
}

function post(path: string, env: any, headers: Record<string, string> = {}) {
  return adminApp.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
  }, env);
}

describe("POST /refresh-all", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await post("/refresh-all", mockEnv());
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.detail.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with wrong secret", async () => {
    const res = await post("/refresh-all", mockEnv(), {
      Authorization: "Bearer wrong-secret",
    });
    expect(res.status).toBe(401);
  });

  it("returns enqueued: 0 when no active users", async () => {
    const env = mockEnv();
    const res = await post("/refresh-all", env, {
      Authorization: "Bearer test-secret",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enqueued).toBe(0);
    expect(env.SCHEDULE_SYNC_QUEUE.sendBatch).not.toHaveBeenCalled();
  });
});
```

Note: The "no active users" test works because the mock DB returns `{ results: [] }`. Testing the actual enqueue path with D1 requires the workerd pool integration tests (`src/routes/users.test.ts` pattern). For this simple admin endpoint, the auth and empty-case tests provide sufficient coverage. The enqueue logic is straightforward `sendBatch` calls on the existing queue.

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: 3 tests PASS

**Step 3: Commit**

```bash
git add src/routes/admin.test.ts
git commit -m "test: add admin refresh-all route tests"
```

---

### Task 5: Create admin shell script

**Files:**
- Create: `scripts/admin-refresh-all.sh`

**Step 1: Create the script**

```bash
#!/bin/bash
# Trigger full schedule sync for all active users
# Usage: ./scripts/admin-refresh-all.sh [url]
# Default: https://schedule.cqu.moe
# Requires: ADMIN_SECRET environment variable

set -euo pipefail

if [ -z "${ADMIN_SECRET:-}" ]; then
  echo "Error: ADMIN_SECRET environment variable is not set" >&2
  exit 1
fi

URL="${1:-https://schedule.cqu.moe}"

curl -s -X POST "$URL/api/v1/admin/refresh-all" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" | python3 -m json.tool
```

**Step 2: Make executable**

Run: `chmod +x scripts/admin-refresh-all.sh`

**Step 3: Commit**

```bash
git add scripts/admin-refresh-all.sh
git commit -m "feat: add admin refresh-all shell script"
```

---

### Task 6: Set ADMIN_SECRET and verify

**Step 1: Add ADMIN_SECRET to .dev.vars for local development**

Add a line to `.dev.vars`:
```
ADMIN_SECRET=local-dev-admin-secret
```

**Step 2: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All tests PASS

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit .dev.vars change if appropriate, or remind user to set production secret**

Production secret setup:
```bash
npx wrangler secret put ADMIN_SECRET
```

---

### Task 7: Final commit — squash or leave as-is

Review all changes and create a final commit if tasks were not committed individually, or verify the commit history looks clean.

**Files changed summary:**
- `src/types.ts` — added `ADMIN_SECRET` to Env
- `src/routes/admin.ts` — new admin route module
- `src/routes/admin.test.ts` — tests
- `src/index.ts` — mount admin routes
- `scripts/admin-refresh-all.sh` — CLI script
