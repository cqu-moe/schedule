# CQU API Concurrency Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate unnecessary sequential CQU API calls and add KV cache for personal schedule data deduplication.

**Architecture:** KV short-TTL cache wrapping `fetchPersonalSchedule` to deduplicate across HTTP requests and queue messages. `Promise.all`/`Promise.allSettled` to parallelize independent API calls in sync services, queue consumers, and frontend.

**Tech Stack:** Cloudflare Workers KV, Promise.all/allSettled, vitest mock

---

### Task 1: Parallelize fetchPersonalSchedule (getSchedule + getExams)

**Files:**
- Modify: `src/services/sync.ts:70-82`

**Step 1: Write the failing test**

Create `src/services/sync.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchPersonalSchedule, type SessionContext } from "./sync";
import type { CQUAPIClient } from "./cqu-api";

function mockCtx(): SessionContext {
  return {
    sessionId: "2025-2026-2",
    semesterInfo: { id: 1, name: "2025-2026学年第二学期", begin_date: "2026-02-23" },
  };
}

describe("fetchPersonalSchedule", () => {
  it("should call getSchedule and getExams in parallel", async () => {
    const callOrder: string[] = [];
    const api = {
      getSchedule: vi.fn(async () => {
        callOrder.push("getSchedule:start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("getSchedule:end");
        return [{ name: "Math" }];
      }),
      getExams: vi.fn(async () => {
        callOrder.push("getExams:start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("getExams:end");
        return [{ name: "Math Exam" }];
      }),
    } as unknown as CQUAPIClient;

    const result = await fetchPersonalSchedule(api, "20210001", mockCtx());

    expect(result.courses).toEqual([{ name: "Math" }]);
    expect(result.exams).toEqual([{ name: "Math Exam" }]);
    expect(result.semesterStart).toBe("2026-02-23");
    // Both should start before either ends (parallel execution)
    expect(callOrder.indexOf("getExams:start")).toBeLessThan(callOrder.indexOf("getSchedule:end"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/sync.test.ts`
Expected: FAIL — `getExams:start` comes after `getSchedule:end` (sequential)

**Step 3: Implement the change**

In `src/services/sync.ts`, replace lines 70-82:

```typescript
/** Fetch personal schedule (courses + exams) */
export async function fetchPersonalSchedule(
  api: CQUAPIClient,
  studentId: string,
  ctx: SessionContext,
): Promise<PersonalScheduleData> {
  const [courses, exams] = await Promise.all([
    api.getSchedule(studentId, ctx.sessionId),
    api.getExams(),
  ]);
  return {
    courses,
    exams,
    semesterStart: ctx.semesterInfo.begin_date ?? "",
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/sync.test.ts`
Expected: PASS

**Step 5: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 6: Commit**

```bash
git add src/services/sync.ts src/services/sync.test.ts
git commit -m "perf: parallelize getSchedule+getExams in fetchPersonalSchedule (#26)"
```

---

### Task 2: Add fetchPersonalScheduleCached with KV cache

**Files:**
- Modify: `src/services/sync.ts` (add function after line 82)
- Modify: `src/services/sync.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `src/services/sync.test.ts`:

```typescript
import { fetchPersonalScheduleCached } from "./sync";

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => store[key] ? JSON.parse(store[key]) : null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value; }),
  } as unknown as KVNamespace;
}

describe("fetchPersonalScheduleCached", () => {
  it("should return cached data on cache hit without calling API", async () => {
    const cachedData = { courses: [{ name: "Cached" }], exams: [], semesterStart: "2026-02-23" };
    const kv = mockKV({ "sync:personal:20210001": JSON.stringify(cachedData) });
    const api = {
      getSchedule: vi.fn(),
      getExams: vi.fn(),
    } as unknown as CQUAPIClient;

    const result = await fetchPersonalScheduleCached(api, "20210001", mockCtx(), kv);

    expect(result).toEqual(cachedData);
    expect(api.getSchedule).not.toHaveBeenCalled();
    expect(api.getExams).not.toHaveBeenCalled();
  });

  it("should fetch from API and write to KV on cache miss", async () => {
    const kv = mockKV();
    const api = {
      getSchedule: vi.fn(async () => [{ name: "Math" }]),
      getExams: vi.fn(async () => []),
    } as unknown as CQUAPIClient;

    const result = await fetchPersonalScheduleCached(api, "20210001", mockCtx(), kv);

    expect(result.courses).toEqual([{ name: "Math" }]);
    expect(api.getSchedule).toHaveBeenCalledOnce();
    expect(kv.put).toHaveBeenCalledWith(
      "sync:personal:20210001",
      expect.any(String),
      { expirationTtl: 300 },
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/sync.test.ts`
Expected: FAIL — `fetchPersonalScheduleCached` not defined

**Step 3: Implement fetchPersonalScheduleCached**

Add after `fetchPersonalSchedule` in `src/services/sync.ts`:

```typescript
const PERSONAL_CACHE_TTL = 300; // 5 minutes

/** Fetch personal schedule with KV cache to deduplicate across requests */
export async function fetchPersonalScheduleCached(
  api: CQUAPIClient,
  studentId: string,
  ctx: SessionContext,
  kv: KVNamespace,
): Promise<PersonalScheduleData> {
  const cacheKey = `sync:personal:${studentId}`;
  const cached = await kv.get(cacheKey, "json");
  if (cached) return cached as PersonalScheduleData;

  const data = await fetchPersonalSchedule(api, studentId, ctx);
  await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: PERSONAL_CACHE_TTL });
  return data;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/sync.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/sync.ts src/services/sync.test.ts
git commit -m "perf: add KV-cached fetchPersonalScheduleCached (#26)"
```

---

### Task 3: Use fetchPersonalScheduleCached in subscriptions refresh endpoint

**Files:**
- Modify: `src/routes/subscriptions.ts:264` (change `fetchPersonalSchedule` → `fetchPersonalScheduleCached`)

**Step 1: Update the import**

In `src/routes/subscriptions.ts`, add `fetchPersonalScheduleCached` to the import from `../services/sync` (line 21). Remove `fetchPersonalSchedule` from the import since it's no longer used directly here.

**Step 2: Replace the call**

Change line 264 from:
```typescript
const data = await fetchPersonalSchedule(api, user.studentId, ctx);
```
to:
```typescript
const data = await fetchPersonalScheduleCached(api, user.studentId, ctx, c.env.CACHE);
```

**Step 3: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 4: Commit**

```bash
git add src/routes/subscriptions.ts
git commit -m "perf: use cached personal schedule in refresh endpoint (#26)"
```

---

### Task 4: Use fetchPersonalScheduleCached in schedule-sync consumer

**Files:**
- Modify: `src/cron/schedule-sync.ts:108` (change `fetchPersonalSchedule` → `fetchPersonalScheduleCached`)

**Step 1: Update the import**

In `src/cron/schedule-sync.ts`, replace `fetchPersonalSchedule` with `fetchPersonalScheduleCached` in the import from `../services/sync` (line 11).

**Step 2: Replace the call**

Change line 108 from:
```typescript
personalData = await fetchPersonalSchedule(api, user.studentId, ctx);
```
to:
```typescript
personalData = await fetchPersonalScheduleCached(api, user.studentId, ctx, env.CACHE);
```

**Step 3: Remove unused import**

Remove `type PersonalScheduleData` from the import if the variable type is already inferred. Keep it if `personalData` declaration on line 99 needs the explicit type.

Actually, `personalData` is declared as `let personalData: PersonalScheduleData | null = null` on line 99, so `PersonalScheduleData` is still needed.

**Step 4: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 5: Commit**

```bash
git add src/cron/schedule-sync.ts
git commit -m "perf: use cached personal schedule in sync consumer (#26)"
```

---

### Task 5: Parallelize token-refresh consumer

**Files:**
- Modify: `src/cron/token-refresh.ts:48-142`

**Step 1: Write the failing test**

Add consumer tests to `src/cron/token-refresh.test.ts`:

```typescript
import { processTokenRefreshBatch } from "./token-refresh";

function mockMessage(body: { userId: string; studentId: string }) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("processTokenRefreshBatch (consumer)", () => {
  it("should process messages in parallel (not sequentially)", async () => {
    // Insert 2 users that need refresh
    const id1 = await insertUser(db, {
      studentId: "20210020",
      tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const id2 = await insertUser(db, {
      studentId: "20210021",
      tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const callOrder: string[] = [];
    const mockRefreshToken = vi.fn(async () => {
      const id = callOrder.length;
      callOrder.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`end:${id}`);
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      };
    });

    // Mock the auth module
    vi.doMock("../services/auth", () => ({
      refreshToken: mockRefreshToken,
      login: vi.fn(),
      AuthError: class extends Error { code: string; constructor(m: string, c: string) { super(m); this.code = c; } },
    }));

    const msg1 = mockMessage({ userId: id1, studentId: "20210020" });
    const msg2 = mockMessage({ userId: id2, studentId: "20210021" });
    const batch = {
      messages: [msg1, msg2],
      queue: "test",
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<TokenRefreshMessage>;

    await processTokenRefreshBatch(batch, {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);

    expect(msg1.ack).toHaveBeenCalled();
    expect(msg2.ack).toHaveBeenCalled();
    // Both should start before either ends (parallel)
    expect(callOrder.indexOf("start:1")).toBeLessThan(callOrder.indexOf("end:0"));
  });
});
```

Note: This test may be complex to wire up with the existing test infrastructure. If vi.doMock proves difficult in workerd, an alternative approach is to just verify behavior (both messages acked) and trust the `Promise.allSettled` implementation. The test could be simplified to:

```typescript
describe("processTokenRefreshBatch (consumer)", () => {
  it("should ack user messages that no longer need refresh", async () => {
    // User with token expiring in 3 hours (> 2h threshold)
    const id = await insertUser(db, {
      studentId: "20210020",
      tokenExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });

    const msg = mockMessage({ userId: id, studentId: "20210020" });
    const batch = {
      messages: [msg],
      queue: "test",
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<TokenRefreshMessage>;

    await processTokenRefreshBatch(batch, {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);

    expect(msg.ack).toHaveBeenCalled();
  });

  it("should ack messages for non-existent users", async () => {
    const msg = mockMessage({ userId: "nonexistent", studentId: "00000000" });
    const batch = {
      messages: [msg],
      queue: "test",
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<TokenRefreshMessage>;

    await processTokenRefreshBatch(batch, {
      ...env,
      ENCRYPTION_KEY: TEST_KEY,
    } as unknown as Env);

    expect(msg.ack).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify behavior before change**

Run: `npx vitest run src/cron/token-refresh.test.ts`
Expected: PASS (the simplified tests should pass with current sequential code too)

**Step 3: Implement parallel processing**

Replace the `for` loop in `processTokenRefreshBatch` (lines 48-142) with:

```typescript
export async function processTokenRefreshBatch(
  batch: MessageBatch<TokenRefreshMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const { userId, studentId } = message.body;
      try {
        // [existing per-message logic stays exactly the same]
        // Read fresh user data ...
        // Check if still needs refresh ...
        // Try refresh token first ...
        // Fallback: re-login ...
        message.ack();
      } catch (e) {
        // [existing error handling stays exactly the same]
      }
    }),
  );
}
```

The inner logic of each message handler stays identical — only the outer loop changes from `for...of` to `Promise.allSettled(batch.messages.map(...))`.

**Step 4: Run tests**

Run: `npx vitest run src/cron/token-refresh.test.ts`
Expected: All pass

**Step 5: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 6: Commit**

```bash
git add src/cron/token-refresh.ts src/cron/token-refresh.test.ts
git commit -m "perf: parallelize token-refresh consumer with Promise.allSettled (#26)"
```

---

### Task 6: Parallelize schedule-sync consumer

**Files:**
- Modify: `src/cron/schedule-sync.ts:104-139`

**Step 1: Implement parallel subscription processing**

Replace the inner `for (const sub of userSubs)` loop (lines 104-139) with:

```typescript
      // Split subscriptions by type
      const personalSubs = userSubs.filter((s) => PERSONAL_SOURCE_TYPES.has(s.sourceType));
      const exploreSubs = userSubs.filter((s) => !PERSONAL_SOURCE_TYPES.has(s.sourceType));

      // Process personal subscriptions
      let personalData: PersonalScheduleData | null = null;
      let personalFetchFailed = false;

      if (personalSubs.length > 0) {
        try {
          personalData = await fetchPersonalScheduleCached(api, user.studentId, ctx, env.CACHE);
        } catch (e) {
          personalFetchFailed = true;
          console.error(JSON.stringify({ event: "queue.schedule_sync.personal_failed", studentId, error: e instanceof Error ? e.message : String(e), message: "Personal schedule fetch failed" }));
        }

        if (personalData) {
          const personalResults = await Promise.allSettled(
            personalSubs.map(async (sub) => {
              const result = await buildPersonalSyncResult(sub.sourceType, personalData!, user.studentId);
              await applySyncResult(db, sub.id, result, ctx, {
                sessionId: sub.sessionId,
                sessionName: sub.sessionName,
              });
              console.log(JSON.stringify({ event: "queue.schedule_sync.subscription_synced", studentId, source: sub.sourceName, message: "Subscription synced" }));
            }),
          );
          syncedAny = personalResults.some((r) => r.status === "fulfilled");
        }
      }

      // Process explore subscriptions in parallel
      let exploreFetchFailed = false;
      if (exploreSubs.length > 0) {
        const exploreResults = await Promise.allSettled(
          exploreSubs.map(async (sub) => {
            const result = await buildExploreSyncResult(
              api, sub.sourceType, sub.sourceId, user.studentId, ctx,
            );
            await applySyncResult(db, sub.id, result, ctx, {
              sessionId: sub.sessionId,
              sessionName: sub.sessionName,
            });
            console.log(JSON.stringify({ event: "queue.schedule_sync.subscription_synced", studentId, source: sub.sourceName, message: "Subscription synced" }));
          }),
        );
        exploreFetchFailed = exploreResults.some((r) => r.status === "rejected");
        if (exploreResults.some((r) => r.status === "fulfilled")) syncedAny = true;

        // Log explore failures
        for (const r of exploreResults) {
          if (r.status === "rejected") {
            console.error(JSON.stringify({ event: "queue.schedule_sync.explore_failed", studentId, error: r.reason instanceof Error ? r.reason.message : String(r.reason), message: "Explore subscription fetch failed" }));
          }
        }
      }
```

Also move `let syncedAny = false;` declaration before the split (keep on line 102), and remove the old `let personalData`, `let personalFetchFailed`, `let exploreFetchFailed` declarations from lines 99-101 since they're now declared inside the new block structure.

**Step 2: Also parallelize message-level processing**

Replace the outer `for (const message of batch.messages)` loop (line 57) with `Promise.allSettled(batch.messages.map(...))`, same pattern as token-refresh.

**Step 3: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 4: Commit**

```bash
git add src/cron/schedule-sync.ts
git commit -m "perf: parallelize schedule-sync consumer with Promise.allSettled (#26)"
```

---

### Task 7: Parallelize frontend handleSyncAll

**Files:**
- Modify: `frontend/src/views/Dashboard.vue` (handleSyncAll function, ~line 388)

**Step 1: Write the failing test**

Add to `frontend/src/views/__tests__/Dashboard.test.ts`:

```typescript
  it('sync all calls refreshSubscription in parallel (not sequentially)', async () => {
    const callOrder: string[] = []
    mockApi.refreshSubscription.mockImplementation(async (_token: string, subToken: string) => {
      callOrder.push(`start:${subToken}`)
      await new Promise(r => setTimeout(r, 50))
      callOrder.push(`end:${subToken}`)
      return {}
    })

    const subs = [
      mockSubscription({ calendar_token: 'p1', is_personal: true }),
      mockSubscription({ calendar_token: 'p2', is_personal: true, source_type: 'personal_courses' }),
    ]
    const { wrapper } = await mountDashboard(subs)

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步所有'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    // Both should start before either ends
    expect(callOrder.indexOf('start:p2')).toBeLessThan(callOrder.indexOf('end:p1'))
  })
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/__tests__/Dashboard.test.ts`
Expected: FAIL — `start:p2` comes after `end:p1` (sequential for loop)

**Step 3: Implement the change**

In `frontend/src/views/Dashboard.vue`, change the `handleSyncAll` function (~line 385-398):

From:
```typescript
async function handleSyncAll() {
  try {
    await syncFeedback.run(async () => {
      const personalSubs = subStore.subscriptions.filter(s => s.is_personal)
      for (const sub of personalSubs) {
        await api.refreshSubscription(authStore.token, sub.calendar_token)
      }
      await subStore.load().catch(() => {})
      await authStore.fetchUserInfo()
    })
  } catch (error) {
    toast.error(parseApiError(error, '同步失败'))
  }
}
```

To:
```typescript
async function handleSyncAll() {
  try {
    await syncFeedback.run(async () => {
      const personalSubs = subStore.subscriptions.filter(s => s.is_personal)
      await Promise.all(
        personalSubs.map(sub => api.refreshSubscription(authStore.token, sub.calendar_token))
      )
      await subStore.load().catch(() => {})
      await authStore.fetchUserInfo()
    })
  } catch (error) {
    toast.error(parseApiError(error, '同步失败'))
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/views/__tests__/Dashboard.test.ts`
Expected: All pass

**Step 5: Run all frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 6: Commit**

```bash
git add frontend/src/views/Dashboard.vue frontend/src/views/__tests__/Dashboard.test.ts
git commit -m "perf: parallelize frontend handleSyncAll with Promise.all (#26)"
```

---

### Task 8: Final verification and typecheck

**Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No new errors

**Step 2: Run all backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All pass

**Step 3: Run all frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 4: Create PR**

```bash
gh pr create --title "perf: optimize CQU API calls with concurrency and batch refresh (#26)" \
  --body "$(cat <<'EOF'
## Summary
- Parallelize `getSchedule()` + `getExams()` calls in `fetchPersonalSchedule` with `Promise.all`
- Add KV-cached `fetchPersonalScheduleCached` (5min TTL) to deduplicate personal schedule fetches
- Parallelize token-refresh queue consumer with `Promise.allSettled`
- Parallelize schedule-sync queue consumer (both personal and explore subscriptions)
- Parallelize frontend `handleSyncAll` with `Promise.all`

Closes #26

## Test plan
- [ ] `npx vitest run src/services/sync.test.ts` — new tests for parallel + cache
- [ ] `npx vitest run src/cron/token-refresh.test.ts` — consumer tests
- [ ] `npx vitest run --exclude 'frontend/**'` — all backend tests pass
- [ ] `npm run test:frontend` — frontend tests pass including parallel sync test
- [ ] `npm run typecheck` — no new errors

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
