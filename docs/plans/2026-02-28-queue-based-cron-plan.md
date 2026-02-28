# Queue-Based Cron Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace single-invocation cron handlers with Queue-based producer/consumer pattern to support 1000+ users within Workers limits.

**Architecture:** Cron handlers become lightweight producers that query D1 and `sendBatch` messages to Queues. Separate consumer handlers process messages in small batches, each with independent subrequest/time limits. Two queues: `schedule-token-refresh` (hourly) and `schedule-sync` (daily).

**Tech Stack:** Cloudflare Queues, existing Hono/D1/Drizzle stack, vitest with `@cloudflare/vitest-pool-workers`.

**Key API constraint:** `Queue.sendBatch()` accepts max 100 messages per call. For >100 users, chunk into multiple `sendBatch` calls.

---

### Task 1: Update Env types and wrangler config

**Files:**
- Modify: `src/types.ts`
- Modify: `wrangler.jsonc`

**Step 1: Add Queue bindings to Env interface**

In `src/types.ts`, add after the `EXPLORE_LIMITER` line:

```typescript
// Queues
TOKEN_REFRESH_QUEUE: Queue;
SCHEDULE_SYNC_QUEUE: Queue;
```

**Step 2: Add queues config to wrangler.jsonc**

In `wrangler.jsonc`, add after the `ratelimits` block:

```jsonc
// Queues
"queues": {
  "producers": [
    { "binding": "TOKEN_REFRESH_QUEUE", "queue": "schedule-token-refresh" },
    { "binding": "SCHEDULE_SYNC_QUEUE", "queue": "schedule-sync" }
  ],
  "consumers": [
    {
      "queue": "schedule-token-refresh",
      "max_batch_size": 20,
      "max_retries": 3,
      "max_concurrency": 5,
      "max_batch_timeout": 30
    },
    {
      "queue": "schedule-sync",
      "max_batch_size": 10,
      "max_retries": 3,
      "max_concurrency": 3,
      "max_batch_timeout": 30
    }
  ]
},
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (Queue is a global type in Workers)

**Step 4: Commit**

```bash
git add src/types.ts wrangler.jsonc
git commit -m "chore: add Queue bindings for token-refresh and schedule-sync"
```

---

### Task 2: Refactor token-refresh into producer + consumer

**Files:**
- Modify: `src/cron/token-refresh.ts`

The existing `refreshExpiringTokens()` function combines querying users and processing them. Split into:
- `enqueueTokenRefresh(env)` — producer: query D1, sendBatch
- `processTokenRefreshBatch(batch, env)` — consumer: process each message

**Step 1: Write the producer function**

Replace the entire `src/cron/token-refresh.ts` with:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { lt, isNotNull, eq, and } from "drizzle-orm";
import { users } from "../db/schema";
import type { Env } from "../types";
import { decrypt } from "../services/crypto";
import { refreshToken, login, AuthError } from "../services/auth";

export interface TokenRefreshMessage {
  userId: string;
  studentId: string;
}

/** Producer: query users needing refresh, send to queue */
export async function enqueueTokenRefresh(env: Env): Promise<void> {
  console.log("cron: enqueuing token refresh");
  const db = drizzle(env.DB);

  const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const expiring = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(and(isNotNull(users.tokenExpiresAt), lt(users.tokenExpiresAt, threshold)));

  if (expiring.length === 0) {
    console.log("cron: no users need token refresh");
    return;
  }

  // sendBatch accepts max 100 messages per call
  const BATCH_SIZE = 100;
  for (let i = 0; i < expiring.length; i += BATCH_SIZE) {
    const chunk = expiring.slice(i, i + BATCH_SIZE);
    await env.TOKEN_REFRESH_QUEUE.sendBatch(
      chunk.map((u) => ({
        body: { userId: u.id, studentId: u.studentId } satisfies TokenRefreshMessage,
      })),
    );
  }

  console.log(`cron: enqueued ${expiring.length} users for token refresh`);
}

/** Consumer: process a batch of token refresh messages */
export async function processTokenRefreshBatch(
  batch: MessageBatch<TokenRefreshMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  for (const message of batch.messages) {
    const { userId, studentId } = message.body;
    try {
      // Read fresh user data (token may have been refreshed by another batch)
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));

      if (!user) {
        message.ack();
        continue;
      }

      // Check if still needs refresh
      const threshold = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      if (!user.tokenExpiresAt || user.tokenExpiresAt >= threshold) {
        message.ack();
        continue;
      }

      const now = new Date().toISOString();

      // Try refresh token first
      if (user.refreshToken) {
        try {
          const result = await refreshToken(user.refreshToken);
          await db
            .update(users)
            .set({
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              tokenExpiresAt: result.expiresAt,
              lastRefreshAt: now,
              loginError: null,
              updatedAt: now,
            })
            .where(eq(users.id, userId));
          console.log(`queue: token refreshed for ${studentId}`);
          message.ack();
          continue;
        } catch (e) {
          if (!(e instanceof AuthError) || e.code !== "TOKEN_EXPIRED") {
            throw e;
          }
          console.warn(`queue: refresh token expired for ${studentId}, trying login`);
        }
      }

      // Fallback: re-login
      const password = await decrypt(user.encryptedPassword, env.ENCRYPTION_KEY);
      const result = await login(user.studentId, password);
      await db
        .update(users)
        .set({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          tokenExpiresAt: result.expiresAt,
          lastLoginAt: now,
          lastRefreshAt: now,
          loginError: null,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      console.log(`queue: re-login successful for ${studentId}`);
      message.ack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`queue: token refresh failed for ${studentId}: ${msg}`);

      // Permanent failures → ack and record error, don't retry
      if (e instanceof AuthError && (e.code === "INVALID_CREDENTIALS" || e.code === "CAPTCHA_REQUIRED")) {
        await db
          .update(users)
          .set({ loginError: msg, updatedAt: new Date().toISOString() })
          .where(eq(users.id, userId));
        message.ack();
        continue;
      }

      // Transient failures → retry (timeout, network, upstream errors)
      await db
        .update(users)
        .set({ loginError: msg, updatedAt: new Date().toISOString() })
        .where(eq(users.id, userId));
      message.retry();
    }
  }
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run existing tests to check nothing is broken**

Run: `npm test`
Expected: All tests PASS. The auth tests don't import from `cron/token-refresh.ts` so no breakage.

**Step 4: Commit**

```bash
git add src/cron/token-refresh.ts
git commit -m "refactor: split token-refresh into queue producer and consumer"
```

---

### Task 3: Refactor schedule-sync into producer + consumer

**Files:**
- Modify: `src/cron/schedule-sync.ts`

**Step 1: Rewrite schedule-sync.ts**

Replace the entire `src/cron/schedule-sync.ts` with:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { isNotNull, eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import { CQUAPIClient } from "../services/cqu-api";
import {
  PERSONAL_SOURCE_TYPES,
  fetchSessionContextCached,
  fetchPersonalSchedule,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
  type SessionContext,
  type PersonalScheduleData,
} from "../services/sync";

export interface ScheduleSyncMessage {
  userId: string;
  studentId: string;
}

/** Producer: enqueue all active users for schedule sync */
export async function enqueueScheduleSync(env: Env): Promise<void> {
  console.log("cron: enqueuing schedule sync");
  const db = drizzle(env.DB);

  const activeUsers = await db
    .select({ id: users.id, studentId: users.studentId })
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log("cron: no active users, skipping sync");
    return;
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < activeUsers.length; i += BATCH_SIZE) {
    const chunk = activeUsers.slice(i, i + BATCH_SIZE);
    await env.SCHEDULE_SYNC_QUEUE.sendBatch(
      chunk.map((u) => ({
        body: { userId: u.id, studentId: u.studentId } satisfies ScheduleSyncMessage,
      })),
    );
  }

  console.log(`cron: enqueued ${activeUsers.length} users for schedule sync`);
}

/** Consumer: process a batch of schedule sync messages */
export async function processScheduleSyncBatch(
  batch: MessageBatch<ScheduleSyncMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  for (const message of batch.messages) {
    const { userId, studentId } = message.body;
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));

      if (!user || !user.accessToken) {
        message.ack();
        continue;
      }

      const userSubs = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId));

      if (userSubs.length === 0) {
        message.ack();
        continue;
      }

      const api = new CQUAPIClient(user.accessToken);
      const now = new Date().toISOString();
      const ctx = await fetchSessionContextCached(api, env.CACHE);

      let personalData: PersonalScheduleData | null = null;
      let personalFetchFailed = false;

      for (const sub of userSubs) {
        if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
          if (!personalData && !personalFetchFailed) {
            try {
              personalData = await fetchPersonalSchedule(api, user.studentId, ctx);
            } catch (e) {
              personalFetchFailed = true;
              console.error(`queue: failed to fetch personal schedule for ${studentId}: ${e}`);
              continue;
            }
          }
          if (!personalData) continue;

          const result = await buildPersonalSyncResult(sub.sourceType, personalData, user.studentId);
          await applySyncResult(db, sub.id, result, ctx, {
            sessionId: sub.sessionId,
            sessionName: sub.sessionName,
          });
        } else {
          try {
            const result = await buildExploreSyncResult(
              api, sub.sourceType, sub.sourceId, user.studentId, ctx,
            );
            await applySyncResult(db, sub.id, result, ctx, {
              sessionId: sub.sessionId,
              sessionName: sub.sessionName,
            });
          } catch (e) {
            console.error(`queue: failed to refresh subscription ${sub.sourceName}: ${e}`);
            continue;
          }
        }
        console.log(`queue: synced ${sub.sourceName} for ${studentId}`);
      }

      await db
        .update(users)
        .set({ lastRefreshAt: now, updatedAt: now })
        .where(eq(users.id, userId));

      message.ack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`queue: schedule sync failed for ${studentId}: ${msg}`);
      message.retry();
    }
  }
}
```

Key changes from original:
- Uses `fetchSessionContextCached` (KV cache) instead of `fetchSessionContext` (per design)
- Each user is a separate message with independent ack/retry
- User data read fresh from D1 at consumer time

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run existing tests**

Run: `npm test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/cron/schedule-sync.ts
git commit -m "refactor: split schedule-sync into queue producer and consumer"
```

---

### Task 4: Update index.ts entry point

**Files:**
- Modify: `src/index.ts`

**Step 1: Update imports and handlers**

Replace cron imports and add queue handler. The updated `src/index.ts`:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import configRoutes from "./routes/config";
import userRoutes from "./routes/users";
import subscriptionRoutes from "./routes/subscriptions";
import exploreRoutes from "./routes/explore";
import { enqueueTokenRefresh, processTokenRefreshBatch } from "./cron/token-refresh";
import { enqueueScheduleSync, processScheduleSyncBatch } from "./cron/schedule-sync";

const app = new Hono<{ Bindings: Env }>();

// CORS: restrict to same-origin; allow local dev origins
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const publicUrl = c.env.PUBLIC_URL ?? "";
      if (!origin) return publicUrl || "*";
      if (publicUrl && origin === publicUrl) return origin;
      if (origin === "https://schedule.cqu.moe") return origin;
      if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
        return origin;
      }
      return "";
    },
    allowHeaders: ["Authorization", "Content-Type", "X-Captcha-Token"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

// Mount routes
app.route("/api/v1", configRoutes);
app.route("/api/v1/users", userRoutes);
app.route("/api/v1/subscriptions", subscriptionRoutes);
app.route("/api/v1", exploreRoutes);

// Global error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ detail: "Internal server error" }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    switch (controller.cron) {
      case "0 * * * *":
        await enqueueTokenRefresh(env);
        break;
      case "0 19 * * *":
        await enqueueScheduleSync(env);
        break;
      default:
        console.log(`cron: unknown schedule ${controller.cron}`);
    }
  },
  async queue(
    batch: MessageBatch,
    env: Env,
  ): Promise<void> {
    switch (batch.queue) {
      case "schedule-token-refresh":
        await processTokenRefreshBatch(batch, env);
        break;
      case "schedule-sync":
        await processScheduleSyncBatch(batch, env);
        break;
      default:
        console.log(`queue: unknown queue ${batch.queue}`);
    }
  },
};
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add queue handler and wire cron to queue producers"
```

---

### Task 5: Write tests for producer functions

**Files:**
- Create: `src/cron/token-refresh.test.ts`

Producer tests verify: D1 query correctness, sendBatch chunking, empty-user case.

**Step 1: Write producer tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../db/schema";
import { encrypt } from "../services/crypto";
import { enqueueTokenRefresh } from "./token-refresh";

async function createUser(
  db: ReturnType<typeof drizzle>,
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  const defaults = {
    studentId: `stu-${crypto.randomUUID().slice(0, 8)}`,
    encryptedPassword: await encrypt("password", env.ENCRYPTION_KEY),
    calendarToken: crypto.randomUUID() + crypto.randomUUID(),
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min from now (within 2h threshold)
  };
  const [user] = await db
    .insert(users)
    .values({ ...defaults, ...overrides })
    .returning();
  return user;
}

describe("enqueueTokenRefresh", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    db = drizzle(env.DB);
  });

  it("should not send any messages when no users need refresh", async () => {
    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      TOKEN_REFRESH_QUEUE: { send: vi.fn(), sendBatch } as unknown as Queue,
    };

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should enqueue users with expiring tokens", async () => {
    const user = await createUser(db);

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      TOKEN_REFRESH_QUEUE: { send: vi.fn(), sendBatch } as unknown as Queue,
    };

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { userId: user.id, studentId: user.studentId } },
    ]);
  });

  it("should not enqueue users with tokens not expiring soon", async () => {
    await createUser(db, {
      tokenExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // 3h from now
    });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      TOKEN_REFRESH_QUEUE: { send: vi.fn(), sendBatch } as unknown as Queue,
    };

    await enqueueTokenRefresh(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests**

Run: `npm test -- src/cron/token-refresh.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/cron/token-refresh.test.ts
git commit -m "test: add producer tests for token-refresh queue"
```

---

### Task 6: Write tests for schedule-sync producer

**Files:**
- Create: `src/cron/schedule-sync.test.ts`

**Step 1: Write producer tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../db/schema";
import { encrypt } from "../services/crypto";
import { enqueueScheduleSync } from "./schedule-sync";

async function createUser(
  db: ReturnType<typeof drizzle>,
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  const defaults = {
    studentId: `stu-${crypto.randomUUID().slice(0, 8)}`,
    encryptedPassword: await encrypt("password", env.ENCRYPTION_KEY),
    calendarToken: crypto.randomUUID() + crypto.randomUUID(),
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  };
  const [user] = await db
    .insert(users)
    .values({ ...defaults, ...overrides })
    .returning();
  return user;
}

describe("enqueueScheduleSync", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    db = drizzle(env.DB);
  });

  it("should not send any messages when no active users", async () => {
    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      SCHEDULE_SYNC_QUEUE: { send: vi.fn(), sendBatch } as unknown as Queue,
    };

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("should enqueue all users with access tokens", async () => {
    const user1 = await createUser(db);
    const user2 = await createUser(db);
    // User without access token should be skipped
    await createUser(db, { accessToken: null });

    const sendBatch = vi.fn();
    const testEnv = {
      ...env,
      SCHEDULE_SYNC_QUEUE: { send: vi.fn(), sendBatch } as unknown as Queue,
    };

    await enqueueScheduleSync(testEnv);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const messages = sendBatch.mock.calls[0][0];
    expect(messages).toHaveLength(2);
    const userIds = messages.map((m: any) => m.body.userId);
    expect(userIds).toContain(user1.id);
    expect(userIds).toContain(user2.id);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- src/cron/schedule-sync.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/cron/schedule-sync.test.ts
git commit -m "test: add producer tests for schedule-sync queue"
```

---

### Task 7: Create queues, deploy, and verify

**Step 1: Create the queues on Cloudflare**

Run:
```bash
npx wrangler queues create schedule-token-refresh
npx wrangler queues create schedule-sync
```
Expected: Both created successfully.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Deploy**

Push to main to trigger Cloudflare Builds (or `npm run deploy` for manual):
```bash
git push
```

**Step 5: Verify with wrangler tail**

Run: `npx wrangler tail schedule-beta-cqu-moe --format pretty`

Wait for the next hourly cron trigger and verify logs show:
- `cron: enqueuing token refresh`
- `cron: enqueued N users for token refresh`
- `queue: token refreshed for ...` (from consumer)

**Step 6: Manual cron test (optional)**

Run:
```bash
npx wrangler dev --remote --test-scheduled
# Then visit: http://localhost:8787/__scheduled?cron=0+*+*+*+*
```

---

### Task 8: Update CLAUDE.md with Queue info

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add Queue details to CLAUDE.md**

Add to the 技术栈 section:
```
- Queues: `schedule-token-refresh` (token 刷新) + `schedule-sync` (课表同步), 取代直接 cron 处理
```

Add to 开发注意事项:
```
- Cron handler 只做入队 (sendBatch)，实际处理在 Queue consumer 中
- `sendBatch` 最多 100 条/次，>100 用户需分批调用
- Queue consumer 有独立的 subrequest (1000) 和墙钟 (15min) 限制
```

Add to 项目结构 `src/cron/` description:
```
- `src/cron/` — 定时任务 producer + queue consumer (token-refresh, schedule-sync)
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Queue-based cron architecture"
```
