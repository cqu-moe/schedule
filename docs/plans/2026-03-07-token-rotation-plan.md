# Token Rotation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to rotate their auth token (two-step confirm) and subscription URLs (single + batch), addressing OWASP A07.

**Architecture:** DB adds `pending_calendar_token` + `pending_token_expires_at` to users table. Auth token rotation is two-step (prepare → blind confirm). Subscription URL rotation is single-step with confirmation dialog. All tokens checked for cross-table collision.

**Tech Stack:** Hono routes, Drizzle ORM, D1, Vue 3 + shadcn-vue AlertDialog, vitest

---

### Task 1: Database Schema — Add Pending Token Columns

**Files:**
- Modify: `src/db/schema.ts:6-39` (users table)
- Create: `drizzle/migrations/0002_pending_calendar_token.sql`

**Step 1: Update Drizzle schema**

Add two columns to the `users` table in `src/db/schema.ts`:

```typescript
// After line 23 (calendarToken), add:
  pendingCalendarToken: text("pending_calendar_token").unique(),
  pendingTokenExpiresAt: text("pending_token_expires_at"),
```

**Step 2: Create migration SQL**

Create `drizzle/migrations/0002_pending_calendar_token.sql`:

```sql
ALTER TABLE `users` ADD `pending_calendar_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `pending_token_expires_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_pending_calendar_token_unique` ON `users` (`pending_calendar_token`);
```

**Step 3: Apply migration locally**

Run: `npm run db:migrate:local`
Expected: Migration applied successfully

**Step 4: Commit**

```
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add pending_calendar_token columns for token rotation"
```

---

### Task 2: Token Generation Utility — Collision-Safe Generator

**Files:**
- Modify: `src/utils/token.ts`
- Create: `src/utils/token.test.ts`

**Step 1: Write the failing tests**

Create `src/utils/token.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateUniqueToken } from "./token";

describe("generateUniqueToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a token when no collision", async () => {
    const checker = vi.fn().mockResolvedValue(false);
    const token = await generateUniqueToken(checker);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(checker).toHaveBeenCalledOnce();
  });

  it("retries when collision detected", async () => {
    const checker = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const token = await generateUniqueToken(checker);
    expect(typeof token).toBe("string");
    expect(checker).toHaveBeenCalledTimes(3);
  });

  it("throws after max retries", async () => {
    const checker = vi.fn().mockResolvedValue(true);
    await expect(generateUniqueToken(checker, 3)).rejects.toThrow("Failed to generate unique token");
    expect(checker).toHaveBeenCalledTimes(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/token.test.ts`
Expected: FAIL — `generateUniqueToken` not exported

**Step 3: Implement generateUniqueToken**

Add to `src/utils/token.ts` (keep existing `generateToken`, add below it):

```typescript
/**
 * Generate a token guaranteed not to collide with existing tokens.
 * @param collisionChecker - async function that returns true if token exists
 * @param maxRetries - maximum retry attempts (default 5)
 */
export async function generateUniqueToken(
  collisionChecker: (token: string) => Promise<boolean>,
  maxRetries = 5,
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const token = generateToken();
    if (!(await collisionChecker(token))) {
      return token;
    }
  }
  throw new Error("Failed to generate unique token");
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/token.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```
git add src/utils/token.ts src/utils/token.test.ts
git commit -m "feat: add collision-safe token generator"
```

---

### Task 3: Token Collision Checker Helper

**Files:**
- Create: `src/utils/token-collision.ts`
- Create: `src/utils/token-collision.test.ts`

**Step 1: Write the failing tests**

Create `src/utils/token-collision.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { tokenExists } from "./token-collision";

describe("tokenExists", () => {
  it("returns false when token not found anywhere", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const db = { select: mockSelect } as any;
    const result = await tokenExists(db, "unique-token");
    expect(result).toBe(false);
    // Called twice: once for users, once for subscriptions
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("returns true when token found in users table (short-circuits)", async () => {
    let callCount = 0;
    const mockSelect = vi.fn().mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              callCount === 1 ? [{ id: "u1" }] : [],
            ),
          }),
        }),
      };
    });
    const db = { select: mockSelect } as any;
    const result = await tokenExists(db, "existing-token");
    expect(result).toBe(true);
    // Should short-circuit — only 1 call
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("returns true when token found in subscriptions table", async () => {
    let callCount = 0;
    const mockSelect = vi.fn().mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              callCount === 2 ? [{ id: "s1" }] : [],
            ),
          }),
        }),
      };
    });
    const db = { select: mockSelect } as any;
    const result = await tokenExists(db, "sub-token");
    expect(result).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/token-collision.test.ts`
Expected: FAIL — module not found

**Step 3: Implement tokenExists**

Create `src/utils/token-collision.ts`:

```typescript
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";

/**
 * Check if a token already exists in users.calendar_token or subscriptions.calendar_token.
 */
export async function tokenExists(db: DrizzleD1Database, token: string): Promise<boolean> {
  const [userMatch] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.calendarToken, token))
    .limit(1);

  if (userMatch) return true;

  const [subMatch] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.calendarToken, token))
    .limit(1);

  return !!subMatch;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/token-collision.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```
git add src/utils/token-collision.ts src/utils/token-collision.test.ts
git commit -m "feat: add cross-table token collision checker"
```

---

### Task 4: Auth Token Rotation — Backend Routes

**Files:**
- Modify: `src/routes/users.ts`
- Create: `src/routes/users-rotate.test.ts`

**Step 1: Write failing tests**

Create `src/routes/users-rotate.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/captcha", () => ({
  verifyCaptcha: vi.fn().mockResolvedValue(undefined),
  CaptchaError: class extends Error {},
}));
vi.mock("../services/auth", () => ({
  login: vi.fn(),
  AuthError: class extends Error { code = ""; },
}));

import usersApp from "./users";

function mockPrepare() {
  return {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    raw: vi.fn().mockResolvedValue([]),
  };
}

function createMockEnv(dbOverrides: Record<string, unknown> = {}) {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue(mockPrepare()),
      batch: vi.fn().mockImplementation((stmts: any[]) =>
        Promise.all(stmts.map(() => ({ results: [] })))
      ),
      ...dbOverrides,
    },
    AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    HCAPTCHA_ENABLED: "false",
  } as any;
}

function authPost(path: string, token: string, body?: Record<string, unknown>, env?: any) {
  return usersApp.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env ?? createMockEnv(),
  );
}

describe("POST /me/rotate-token (prepare)", () => {
  it("returns 401 without auth header", async () => {
    const res = await usersApp.request(
      "/me/rotate-token",
      { method: "POST" },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await authPost("/me/rotate-token", "invalid-token");
    expect(res.status).toBe(401);
  });

  it("returns new_token on success", async () => {
    const prep = mockPrepare();
    let callCount = 0;
    prep.all.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // requireAuth lookup
        return { results: [{ id: "u1", student_id: "20210001", calendar_token: "valid-token", created_at: "2026-01-01", last_refresh_at: null }] };
      }
      // collision checks + update
      return { results: [] };
    });

    const env = createMockEnv({ prepare: vi.fn().mockReturnValue(prep) });
    const res = await authPost("/me/rotate-token", "valid-token", undefined, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.new_token).toBeDefined();
    expect(typeof body.new_token).toBe("string");
  });
});

describe("POST /me/rotate-token/confirm", () => {
  it("returns 400 without token in body", async () => {
    const prep = mockPrepare();
    prep.all.mockResolvedValueOnce({
      results: [{ id: "u1", student_id: "20210001", calendar_token: "valid-token", created_at: "2026-01-01", last_refresh_at: null }],
    });

    const env = createMockEnv({ prepare: vi.fn().mockReturnValue(prep) });
    const res = await authPost("/me/rotate-token/confirm", "valid-token", {}, env);
    expect(res.status).toBe(400);
  });

  it("returns 404 when no pending token", async () => {
    const prep = mockPrepare();
    let callCount = 0;
    prep.all.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { results: [{ id: "u1", student_id: "20210001", calendar_token: "valid-token", created_at: "2026-01-01", last_refresh_at: null }] };
      }
      return { results: [{ pending_calendar_token: null, pending_token_expires_at: null }] };
    });

    const env = createMockEnv({ prepare: vi.fn().mockReturnValue(prep) });
    const res = await authPost("/me/rotate-token/confirm", "valid-token", { token: "some-token" }, env);
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/users-rotate.test.ts`
Expected: FAIL — routes don't exist yet

**Step 3: Add rotation routes to users.ts**

Add imports at top of `src/routes/users.ts`:

```typescript
import { generateUniqueToken } from "../utils/token";
import { tokenExists } from "../utils/token-collision";
```

Add these routes after the existing `POST /recover/verify` route (around line 271) and before `syncNewUserSubscriptions`:

```typescript
// POST /api/v1/users/me/rotate-token (prepare)
app.post("/me/rotate-token", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const newToken = await generateUniqueToken((t) => tokenExists(db, t));

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  await db
    .update(users)
    .set({
      pendingCalendarToken: newToken,
      pendingTokenExpiresAt: expiresAt,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return c.json({ new_token: newToken });
});

// POST /api/v1/users/me/rotate-token/confirm
app.post("/me/rotate-token/confirm", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  let body: { token: string };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
  }
  if (!body.token) {
    return errorResponse("BAD_REQUEST", "token is required", 400);
  }

  const [pending] = await db
    .select({
      pendingCalendarToken: users.pendingCalendarToken,
      pendingTokenExpiresAt: users.pendingTokenExpiresAt,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!pending?.pendingCalendarToken) {
    return errorResponse("PENDING_NOT_FOUND", "No pending token rotation", 404);
  }

  if (new Date(pending.pendingTokenExpiresAt!) <= new Date()) {
    await db
      .update(users)
      .set({ pendingCalendarToken: null, pendingTokenExpiresAt: null })
      .where(eq(users.id, user.id));
    return errorResponse("PENDING_EXPIRED", "Token rotation expired, please try again", 410);
  }

  // Timing-safe comparison
  const encoder = new TextEncoder();
  const a = encoder.encode(body.token);
  const b = encoder.encode(pending.pendingCalendarToken);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return errorResponse("TOKEN_MISMATCH", "Token does not match", 422);
  }

  const now = new Date().toISOString();
  await db
    .update(users)
    .set({
      calendarToken: pending.pendingCalendarToken,
      pendingCalendarToken: null,
      pendingTokenExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return c.json({ calendar_token: pending.pendingCalendarToken });
});
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/users-rotate.test.ts`
Expected: PASS

**Step 5: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 6: Commit**

```
git add src/routes/users.ts src/routes/users-rotate.test.ts
git commit -m "feat: add auth token rotation endpoints (prepare + confirm)"
```

---

### Task 5: Subscription URL Rotation — Backend Routes

**Files:**
- Modify: `src/routes/subscriptions.ts`
- Create: `src/routes/subscriptions-rotate.test.ts`

**Step 1: Write failing tests**

Create `src/routes/subscriptions-rotate.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import subsApp from "./subscriptions";

function mockPrepare() {
  return {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    raw: vi.fn().mockResolvedValue([]),
  };
}

function createMockEnv(dbOverrides: Record<string, unknown> = {}) {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue(mockPrepare()),
      batch: vi.fn().mockImplementation((stmts: any[]) =>
        Promise.all(stmts.map(() => ({ results: [] })))
      ),
      ...dbOverrides,
    },
    AUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    EXPLORE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    PUBLIC_URL: "https://schedule.cqu.moe",
    HCAPTCHA_ENABLED: "false",
    CACHE: { get: vi.fn(), put: vi.fn() },
    MAX_SUBSCRIPTIONS: "10",
  } as any;
}

function authPost(path: string, token: string, env?: any) {
  return subsApp.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
    env ?? createMockEnv(),
  );
}

describe("POST /:sub_token/rotate (single)", () => {
  it("returns 401 without auth", async () => {
    const res = await subsApp.request(
      "/some-token/rotate",
      { method: "POST" },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when subscription not found", async () => {
    const prep = mockPrepare();
    let callCount = 0;
    prep.all.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { results: [{ id: "u1", student_id: "20210001", calendar_token: "auth-token", created_at: "2026-01-01", last_refresh_at: null }] };
      }
      return { results: [] };
    });

    const env = createMockEnv({ prepare: vi.fn().mockReturnValue(prep) });
    const res = await authPost("/nonexistent/rotate", "auth-token", env);
    expect(res.status).toBe(404);
  });
});

describe("POST /rotate-all", () => {
  it("returns 401 without auth", async () => {
    const res = await subsApp.request(
      "/rotate-all",
      { method: "POST" },
      createMockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns count 0 when user has no subscriptions", async () => {
    const prep = mockPrepare();
    let callCount = 0;
    prep.all.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { results: [{ id: "u1", student_id: "20210001", calendar_token: "auth-token", created_at: "2026-01-01", last_refresh_at: null }] };
      }
      return { results: [] };
    });

    const env = createMockEnv({ prepare: vi.fn().mockReturnValue(prep) });
    const res = await authPost("/rotate-all", "auth-token", env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.count).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/subscriptions-rotate.test.ts`
Expected: FAIL — routes don't exist

**Step 3: Add rotation routes to subscriptions.ts**

Add imports at top of `src/routes/subscriptions.ts`:

```typescript
import { generateUniqueToken } from "../utils/token";
import { tokenExists } from "../utils/token-collision";
```

Add these routes BEFORE the `/:sub_token/calendar.ics` GET route (around line 275). **Critical:** `/rotate-all` must come before `/:sub_token/rotate` (static before param).

```typescript
// POST /api/v1/subscriptions/rotate-all
app.post("/rotate-all", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const subs = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  if (subs.length === 0) {
    return c.json({ count: 0 });
  }

  const now = new Date().toISOString();
  for (const sub of subs) {
    const newToken = await generateUniqueToken((t) => tokenExists(db, t));
    await db
      .update(subscriptions)
      .set({ calendarToken: newToken, updatedAt: now })
      .where(eq(subscriptions.id, sub.id));
  }

  return c.json({ count: subs.length });
});

// POST /api/v1/subscriptions/:sub_token/rotate
app.post("/:sub_token/rotate", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const subToken = c.req.param("sub_token");
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.calendarToken, subToken),
        eq(subscriptions.userId, user.id),
      ),
    )
    .limit(1);

  if (!sub) return errorResponse("NOT_FOUND", "Subscription not found", 404);

  const newToken = await generateUniqueToken((t) => tokenExists(db, t));
  const now = new Date().toISOString();
  const baseUrl = (c.env.PUBLIC_URL ?? "").replace(/\/$/, "");

  await db
    .update(subscriptions)
    .set({ calendarToken: newToken, updatedAt: now })
    .where(eq(subscriptions.id, sub.id));

  return c.json({
    calendar_token: newToken,
    subscription_url: `${baseUrl}/api/v1/subscriptions/${newToken}/calendar.ics`,
  });
});
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/subscriptions-rotate.test.ts`
Expected: PASS

**Step 5: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 6: Commit**

```
git add src/routes/subscriptions.ts src/routes/subscriptions-rotate.test.ts
git commit -m "feat: add subscription URL rotation endpoints (single + batch)"
```

---

### Task 6: Frontend API Layer

**Files:**
- Modify: `frontend/src/api/index.ts`
- Modify: `frontend/src/types/api.ts`

**Step 1: Add API types**

Add to end of `frontend/src/types/api.ts`:

```typescript
export interface RotateTokenPrepare {
  new_token: string
}

export interface RotateTokenConfirm {
  calendar_token: string
}

export interface RotateSubscription {
  calendar_token: string
  subscription_url: string
}

export interface RotateAllSubscriptions {
  count: number
}
```

**Step 2: Add API methods**

Update imports in `frontend/src/api/index.ts`:

```typescript
import type {
  UserInfo,
  SubscriptionList,
  SearchResult,
  AppConfig,
  HealthStatus,
  Subscription,
  CalendarData,
  RotateTokenPrepare,
  RotateTokenConfirm,
  RotateSubscription,
  RotateAllSubscriptions,
} from '@/types/api'
```

Add methods to the default export object (before the closing `}`):

```typescript
  // Token rotation
  async rotateTokenPrepare(token: string): Promise<RotateTokenPrepare> {
    const response = await client.post('/users/me/rotate-token', null, authHeaders(token))
    return response.data
  },

  async rotateTokenConfirm(token: string, newToken: string): Promise<RotateTokenConfirm> {
    const response = await client.post('/users/me/rotate-token/confirm', { token: newToken }, authHeaders(token))
    return response.data
  },

  async rotateSubscription(token: string, subToken: string): Promise<RotateSubscription> {
    const response = await client.post(`/subscriptions/${subToken}/rotate`, null, authHeaders(token))
    return response.data
  },

  async rotateAllSubscriptions(token: string): Promise<RotateAllSubscriptions> {
    const response = await client.post('/subscriptions/rotate-all', null, authHeaders(token))
    return response.data
  },
```

**Step 3: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 4: Commit**

```
git add frontend/src/api/index.ts frontend/src/types/api.ts
git commit -m "feat(frontend): add token rotation API methods and types"
```

---

### Task 7: Frontend — RotateTokenDialog Component

**Files:**
- Create: `frontend/src/components/RotateTokenDialog.vue`

**Step 1: Create the component**

Create `frontend/src/components/RotateTokenDialog.vue`:

```vue
<template>
  <AlertDialog v-model:open="open">
    <AlertDialogTrigger as-child>
      <slot />
    </AlertDialogTrigger>
    <AlertDialogContent>
      <!-- Loading state -->
      <template v-if="step === 'loading'">
        <AlertDialogHeader>
          <AlertDialogTitle>轮换认证 Token</AlertDialogTitle>
        </AlertDialogHeader>
        <div class="flex items-center justify-center py-8">
          <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer" @click="handleClose">取消</AlertDialogCancel>
        </AlertDialogFooter>
      </template>

      <!-- Page 1: Display new token -->
      <template v-if="step === 'display'">
        <AlertDialogHeader>
          <AlertDialogTitle>轮换认证 Token</AlertDialogTitle>
          <AlertDialogDescription>
            请妥善保存新 Token，关闭后将无法再次查看。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="space-y-3 py-2">
          <div class="bg-muted rounded px-3 py-2">
            <code class="text-sm break-all font-mono">{{ newToken }}</code>
          </div>
          <div class="flex gap-2 items-center">
            <Button
              variant="outline"
              size="sm"
              class="cursor-pointer"
              @click="copyToken"
            >
              <Check v-if="copied" class="h-4 w-4 mr-1.5" />
              <Copy v-else class="h-4 w-4 mr-1.5" />
              {{ copied ? '已复制' : '复制' }}
            </Button>
            <onepassword-save-button v-if="opSaveValue" :value="opSaveValue" />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer" @click="handleClose">取消</AlertDialogCancel>
          <Button class="cursor-pointer" @click="step = 'confirm'">我已保存，下一步</Button>
        </AlertDialogFooter>
      </template>

      <!-- Page 2: Blind confirm -->
      <template v-if="step === 'confirm'">
        <AlertDialogHeader>
          <AlertDialogTitle>确认新 Token</AlertDialogTitle>
          <AlertDialogDescription>
            请输入刚才保存的新 Token 以完成轮换。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="space-y-2 py-2">
          <Input
            v-model="confirmInput"
            placeholder="请输入新 Token"
            :class="{ 'border-destructive': confirmError }"
          />
          <p v-if="confirmError" class="text-sm text-destructive">{{ confirmError }}</p>
        </div>
        <AlertDialogFooter>
          <Button variant="outline" class="cursor-pointer" @click="step = 'display'">返回</Button>
          <Button
            class="cursor-pointer"
            :disabled="!confirmInput || confirming"
            @click="handleConfirm"
          >
            <Loader2 v-if="confirming" class="h-4 w-4 mr-1.5 animate-spin" />
            确认轮换
          </Button>
        </AlertDialogFooter>
      </template>

      <!-- Error state -->
      <template v-if="step === 'error'">
        <AlertDialogHeader>
          <AlertDialogTitle>轮换失败</AlertDialogTitle>
          <AlertDialogDescription>{{ prepareError }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel class="cursor-pointer" @click="handleClose">关闭</AlertDialogCancel>
        </AlertDialogFooter>
      </template>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Copy, Check, Loader2 } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { buildOPSaveValue } from '@/utils/opSave'
import { parseApiError } from '@/utils/error'
import { toast } from 'vue-sonner'
import api from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const authStore = useAuthStore()

const open = ref(false)
const step = ref<'loading' | 'display' | 'confirm' | 'error'>('loading')
const newToken = ref('')
const opSaveValue = ref('')
const copied = ref(false)
const confirmInput = ref('')
const confirmError = ref('')
const confirming = ref(false)
const prepareError = ref('')

watch(open, async (isOpen) => {
  if (!isOpen) return
  step.value = 'loading'
  newToken.value = ''
  opSaveValue.value = ''
  copied.value = false
  confirmInput.value = ''
  confirmError.value = ''
  prepareError.value = ''

  try {
    const result = await api.rotateTokenPrepare(authStore.token)
    newToken.value = result.new_token
    opSaveValue.value = buildOPSaveValue(result.new_token)
    step.value = 'display'
  } catch (error) {
    prepareError.value = parseApiError(error, '生成新 Token 失败')
    step.value = 'error'
  }
})

async function copyToken() {
  try {
    await navigator.clipboard.writeText(newToken.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // ignore
  }
}

async function handleConfirm() {
  confirming.value = true
  confirmError.value = ''
  try {
    const result = await api.rotateTokenConfirm(authStore.token, confirmInput.value)
    authStore.token = result.calendar_token
    localStorage.setItem('calendar_token', result.calendar_token)
    await authStore.fetchUserInfo()
    toast.success('Token 已轮换')
    open.value = false
  } catch (error) {
    confirmError.value = parseApiError(error, '确认失败')
  } finally {
    confirming.value = false
  }
}

function handleClose() {
  open.value = false
}
</script>
```

**Step 2: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```
git add frontend/src/components/RotateTokenDialog.vue
git commit -m "feat(frontend): add RotateTokenDialog component with three-page flow"
```

---

### Task 8: Frontend — Dashboard Integration

**Files:**
- Modify: `frontend/src/views/Dashboard.vue`

**Step 1: Add imports**

Add to the imports in `<script setup>`:

```typescript
import RotateTokenDialog from '@/components/RotateTokenDialog.vue'
import { RotateCw, Link } from 'lucide-vue-next'
```

Note: `RotateCw` is the closest icon in lucide to "rotate key". Check if `KeyRound` exists — if so use that instead.

**Step 2: Add handler functions**

Add in `<script setup>`:

```typescript
async function handleRotateSub(subToken: string) {
  try {
    await api.rotateSubscription(authStore.token, subToken)
    toast.success('订阅链接已重置')
    await subStore.load().catch(() => {})
  } catch (error) {
    toast.error(parseApiError(error, '重置链接失败'))
  }
}

async function handleRotateAll() {
  try {
    const result = await api.rotateAllSubscriptions(authStore.token)
    toast.success(`已重置 ${result.count} 个订阅链接`)
    await subStore.load().catch(() => {})
  } catch (error) {
    toast.error(parseApiError(error, '重置链接失败'))
  }
}
```

**Step 3: Add "重置链接" button to each subscription card**

In the subscription card's button area (after the delete button AlertDialog around line 164), add:

```vue
<AlertDialog>
  <AlertDialogTrigger as-child>
    <Button variant="outline" size="sm" class="cursor-pointer text-destructive hover:text-destructive">
      <RotateCw class="h-4 w-4 mr-1.5" />
      重置链接
    </Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>重置订阅链接</AlertDialogTitle>
      <AlertDialogDescription>
        重置后「{{ sub.source_name }}」的旧订阅链接将立即失效，日历客户端需要重新订阅。
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel class="cursor-pointer">取消</AlertDialogCancel>
      <AlertDialogAction
        class="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
        @click="handleRotateSub(sub.calendar_token)"
      >
        确认重置
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Step 4: Add auth token rotation + rotate-all to danger zone**

In the danger zone section (around line 179), BEFORE the delete account AlertDialog, add:

```vue
<!-- Rotate auth token -->
<div class="mb-4">
  <p class="text-sm text-muted-foreground mb-2">
    轮换认证 Token 后，旧 Token 将立即失效。
  </p>
  <RotateTokenDialog>
    <Button variant="outline" class="cursor-pointer border-destructive/50 text-destructive hover:text-destructive">
      <RotateCw class="h-4 w-4 mr-1.5" />
      轮换认证 Token
    </Button>
  </RotateTokenDialog>
</div>

<!-- Rotate all subscription URLs -->
<div class="mb-4">
  <p class="text-sm text-muted-foreground mb-2">
    重置所有订阅链接后，旧链接将立即失效，日历客户端需要重新订阅。
  </p>
  <AlertDialog>
    <AlertDialogTrigger as-child>
      <Button variant="outline" class="cursor-pointer border-destructive/50 text-destructive hover:text-destructive">
        <Link class="h-4 w-4 mr-1.5" />
        重置所有订阅链接
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>重置所有订阅链接</AlertDialogTitle>
        <AlertDialogDescription>
          重置后所有旧的订阅链接将立即失效，日历客户端需要重新订阅。此操作无法撤销。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel class="cursor-pointer">取消</AlertDialogCancel>
        <AlertDialogAction
          class="cursor-pointer bg-destructive text-destructive-foreground hover:bg-destructive/90"
          @click="handleRotateAll"
        >
          确认重置
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</div>
```

**Step 5: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 6: Commit**

```
git add frontend/src/views/Dashboard.vue
git commit -m "feat(frontend): integrate token rotation into Dashboard"
```

---

### Task 9: Frontend Tests

**Files:**
- Create: `frontend/src/components/__tests__/RotateTokenDialog.test.ts`

**Step 1: Write tests**

Create `frontend/src/components/__tests__/RotateTokenDialog.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { mountWithContext, mockApi } from '@/test-utils'
import RotateTokenDialog from '../RotateTokenDialog.vue'

const { api } = mockApi()

describe('RotateTokenDialog', () => {
  it('renders trigger slot', () => {
    const wrapper = mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Rotate</button>',
      },
    })
    expect(wrapper.text()).toContain('Rotate')
  })

  it('does not call prepare API before dialog opens', () => {
    mountWithContext(RotateTokenDialog, {
      slots: {
        default: '<button>Open</button>',
      },
    })
    expect(api.rotateTokenPrepare).not.toHaveBeenCalled()
  })
})
```

**Step 2: Run frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 3: Commit**

```
git add frontend/src/components/__tests__/RotateTokenDialog.test.ts
git commit -m "test(frontend): add RotateTokenDialog tests"
```

---

### Task 10: Final Verification

**Step 1: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 2: Run all frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 3: Build frontend**

Run: `npm run build:frontend`
Expected: Build succeeds

**Step 4: Typecheck**

Run: `npm run typecheck`
Expected: No new errors (existing tsconfig.node.json errors are pre-existing)

**Step 5: Manual verification with dev server**

Run: `npm run db:migrate:local && npm run dev` (terminal 1)
Run: `npm run dev:frontend` (terminal 2)

Verify:
1. Log in → Dashboard → danger zone shows "轮换认证 Token" and "重置所有订阅链接"
2. Each subscription card has "重置链接" button
3. Auth token rotation flow: click → loading → see new token + copy + 1Password → "我已保存，下一步" → input field → paste → "确认轮换" → success toast, stays logged in
4. Single subscription rotate: click → confirm dialog → URL changes in card
5. Rotate all: click → confirm → all subscription URLs change
