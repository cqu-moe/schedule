# Structured Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert all 21 console.log/warn/error calls to structured JSON format for Workers Observability filtering and aggregation.

**Architecture:** Direct `console.log(JSON.stringify({...}))` at each call site. No helper functions, no libraries. Each log emits `{ event, message, ...contextFields }`.

**Tech Stack:** Cloudflare Workers, existing console API, JSON.stringify

**Design doc:** `docs/plans/2026-03-04-structured-logging-design.md`

---

### Task 1: Convert token-refresh.ts producer logs (3 sites)

**Files:**
- Modify: `src/cron/token-refresh.ts:15,25,44`

**Step 1: Replace the 3 producer log statements**

Line 15 — change:
```ts
console.log("cron: enqueuing token refresh");
```
to:
```ts
console.log(JSON.stringify({ event: "cron.token_refresh.start", message: "Enqueuing token refresh" }));
```

Line 25 — change:
```ts
console.log("cron: no users need token refresh");
```
to:
```ts
console.log(JSON.stringify({ event: "cron.token_refresh.skip", message: "No users need token refresh" }));
```

Line 44 — change:
```ts
console.log(`cron: enqueued ${expiring.length} users for token refresh`);
```
to:
```ts
console.log(JSON.stringify({ event: "cron.token_refresh.enqueued", count: expiring.length, message: `Enqueued ${expiring.length} users for token refresh` }));
```

**Step 2: Run tests**

Run: `npx vitest run src/cron/token-refresh.test.ts`
Expected: All existing tests pass (tests assert on DB state and queue calls, not console output)

**Step 3: Commit**

```bash
git add src/cron/token-refresh.ts
git commit -m "refactor(logging): structured JSON for token-refresh producer"
```

---

### Task 2: Convert token-refresh.ts consumer logs (4 sites)

**Files:**
- Modify: `src/cron/token-refresh.ts:93,100,119,123`

**Step 1: Replace the 4 consumer log statements**

Line 93 — change:
```ts
console.log(`queue: token refreshed for ${studentId}`);
```
to:
```ts
console.log(JSON.stringify({ event: "queue.token_refresh.success", studentId, message: "Token refreshed" }));
```

Line 100 — change:
```ts
console.warn(`queue: refresh token expired for ${studentId}, trying login`);
```
to:
```ts
console.warn(JSON.stringify({ event: "queue.token_refresh.fallback_login", studentId, message: "Refresh token expired, trying login" }));
```

Line 119 — change:
```ts
console.log(`queue: re-login successful for ${studentId}`);
```
to:
```ts
console.log(JSON.stringify({ event: "queue.token_refresh.login_success", studentId, message: "Re-login successful" }));
```

Line 123 — change:
```ts
console.error(`queue: token refresh failed for ${studentId}: ${msg}`);
```
to:
```ts
console.error(JSON.stringify({ event: "queue.token_refresh.failed", studentId, error: msg, message: "Token refresh failed" }));
```

**Step 2: Run tests**

Run: `npx vitest run src/cron/token-refresh.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/cron/token-refresh.ts
git commit -m "refactor(logging): structured JSON for token-refresh consumer"
```

---

### Task 3: Convert schedule-sync.ts producer logs (3 sites)

**Files:**
- Modify: `src/cron/schedule-sync.ts:25,34,52`

**Step 1: Replace the 3 producer log statements**

Line 25 — change:
```ts
console.log("cron: enqueuing schedule sync");
```
to:
```ts
console.log(JSON.stringify({ event: "cron.schedule_sync.start", message: "Enqueuing schedule sync" }));
```

Line 34 — change:
```ts
console.log("cron: no active users, skipping sync");
```
to:
```ts
console.log(JSON.stringify({ event: "cron.schedule_sync.skip", message: "No active users" }));
```

Line 52 — change:
```ts
console.log(`cron: enqueued ${activeUsers.length} users for schedule sync`);
```
to:
```ts
console.log(JSON.stringify({ event: "cron.schedule_sync.enqueued", count: activeUsers.length, message: `Enqueued ${activeUsers.length} users for schedule sync` }));
```

**Step 2: Run tests**

Run: `npx vitest run src/cron/schedule-sync.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/cron/schedule-sync.ts
git commit -m "refactor(logging): structured JSON for schedule-sync producer"
```

---

### Task 4: Convert schedule-sync.ts consumer logs (5 sites)

**Files:**
- Modify: `src/cron/schedule-sync.ts:102,124,129,134,147`

**Step 1: Replace the 5 consumer log statements**

Line 102 — change:
```ts
console.error(`queue: failed to fetch personal schedule for ${studentId}: ${e}`);
```
to:
```ts
console.error(JSON.stringify({ event: "queue.schedule_sync.personal_failed", studentId, error: e instanceof Error ? e.message : String(e), message: "Personal schedule fetch failed" }));
```

Line 124 — change:
```ts
console.error(`queue: failed to refresh subscription ${sub.sourceName}: ${e}`);
```
to:
```ts
console.error(JSON.stringify({ event: "queue.schedule_sync.explore_failed", studentId, source: sub.sourceName, error: e instanceof Error ? e.message : String(e), message: "Explore subscription fetch failed" }));
```

Line 129 — change:
```ts
console.log(`queue: synced ${sub.sourceName} for ${studentId}`);
```
to:
```ts
console.log(JSON.stringify({ event: "queue.schedule_sync.subscription_synced", studentId, source: sub.sourceName, message: "Subscription synced" }));
```

Line 134 — change:
```ts
console.warn(`queue: all syncs failed for ${studentId}, retrying`);
```
to:
```ts
console.warn(JSON.stringify({ event: "queue.schedule_sync.all_failed", studentId, message: "All syncs failed, retrying" }));
```

Line 147 — change:
```ts
console.error(`queue: schedule sync failed for ${studentId}: ${msg}`);
```
to:
```ts
console.error(JSON.stringify({ event: "queue.schedule_sync.failed", studentId, error: msg, message: "Schedule sync failed" }));
```

**Step 2: Run tests**

Run: `npx vitest run src/cron/schedule-sync.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/cron/schedule-sync.ts
git commit -m "refactor(logging): structured JSON for schedule-sync consumer"
```

---

### Task 5: Convert index.ts handler logs (3 sites)

**Files:**
- Modify: `src/index.ts:44,72,88`

**Step 1: Replace the 3 handler log statements**

Line 44 — change:
```ts
console.error("Unhandled error:", err);
```
to:
```ts
console.error(JSON.stringify({ event: "http.unhandled_error", error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, message: "Unhandled error" }));
```

Line 72 — change from `console.log` to `console.warn`:
```ts
console.log(`cron: unknown schedule ${controller.cron}`);
```
to:
```ts
console.warn(JSON.stringify({ event: "http.unknown_cron", cron: controller.cron, message: "Unknown cron schedule" }));
```

Line 88 — change from `console.log` to `console.warn`:
```ts
console.log(`queue: unknown queue ${batch.queue}`);
```
to:
```ts
console.warn(JSON.stringify({ event: "http.unknown_queue", queue: batch.queue, message: "Unknown queue" }));
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors (index.ts has no dedicated test file)

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor(logging): structured JSON for index.ts handlers"
```

---

### Task 6: Convert users.ts and captcha.ts logs (3 sites)

**Files:**
- Modify: `src/routes/users.ts:342,344`
- Modify: `src/services/captcha.ts:28`

**Step 1: Replace users.ts log statements**

Line 342 — change:
```ts
console.log(`registration: synced ${subIds.length} subscriptions for ${studentId}`);
```
to:
```ts
console.log(JSON.stringify({ event: "registration.sync_complete", studentId, count: subIds.length, message: `Synced ${subIds.length} subscriptions` }));
```

Line 344 — change:
```ts
console.error(`registration: background sync failed for ${studentId}:`, e);
```
to:
```ts
console.error(JSON.stringify({ event: "registration.sync_failed", studentId, error: e instanceof Error ? e.message : String(e), message: "Background sync failed" }));
```

**Step 2: Replace captcha.ts log statement**

Line 28 — change:
```ts
console.error("hCaptcha verification network error:", e);
```
to:
```ts
console.error(JSON.stringify({ event: "captcha.network_error", error: e instanceof Error ? e.message : String(e), message: "hCaptcha verification network error" }));
```

**Step 3: Run tests**

Run: `npx vitest run src/routes/users.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/routes/users.ts src/services/captcha.ts
git commit -m "refactor(logging): structured JSON for users.ts and captcha.ts"
```

---

### Task 7: Final verification and ship

**Step 1: Verify no unstructured console calls remain**

Run: `grep -rn 'console\.\(log\|warn\|error\)' src/ --include='*.ts' | grep -v test | grep -v node_modules`
Expected: All 21 lines now use `JSON.stringify`

**Step 2: Run full typecheck + backend tests**

Run: `npx tsc --noEmit && npx vitest run src/`
Expected: Zero TS errors, all tests pass

**Step 3: Push**

Run: `git push`
Expected: Auto-deploy via Cloudflare Builds
