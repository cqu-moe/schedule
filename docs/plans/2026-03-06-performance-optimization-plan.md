# Performance Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve frontend loading speed and backend query efficiency across 8 targeted optimizations.

**Architecture:** Backend changes add a DB index, optimize a query, merge config endpoints, and add Cache-Control headers. Frontend changes add bundle analysis tooling, manual chunk splitting, and deferred hCaptcha loading. All in a single PR on branch `perf/optimization`.

**Tech Stack:** Drizzle ORM (migration), Hono (routes), Vite (build config), rollup-plugin-visualizer, Vue 3

---

### Task 1: DB Index — Add `subscriptions(userId)` Index

**Files:**
- Modify: `src/db/schema.ts:91-98`

**Step 1: Add index to schema**

In `src/db/schema.ts`, add `index` import and a non-unique index to the subscriptions table definition:

```typescript
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
```

Update the table's extra definitions (line 91-98):

```typescript
  (table) => [
    uniqueIndex("uq_user_source_session").on(
      table.userId,
      table.sourceType,
      table.sourceId,
      table.sessionId,
    ),
    index("idx_subscriptions_user_id").on(table.userId),
  ],
```

**Step 2: Generate migration**

Run: `npm run db:generate`
Expected: New migration file in `drizzle/migrations/` with `CREATE INDEX idx_subscriptions_user_id`

**Step 3: Apply migration locally**

Run: `npm run db:migrate:local`
Expected: Migration applied successfully

**Step 4: Run backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All tests pass

**Step 5: Commit**

```
git add src/db/schema.ts drizzle/
git commit -m "perf(db): add index on subscriptions(userId)

Speeds up subscription list queries that filter by userId.
SQLite does not auto-index foreign key columns.

Closes part of #66"
```

---

### Task 2: Optimize Subscription Duplicate Check

**Files:**
- Modify: `src/routes/subscriptions.ts:106-138`

**Step 1: Replace SELECT-all + JS loop with targeted query**

In `src/routes/subscriptions.ts`, the POST handler currently (lines 107-138):
1. Selects ALL user subscriptions to check count AND duplicate
2. Loops through results in JS to find duplicate

Replace with two separate, efficient queries. Change lines 106-138 to:

```typescript
  // Count existing subscriptions
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  if (countResult[0].count >= maxSubs) {
    return errorResponse("MAX_SUBSCRIPTIONS", `Maximum subscriptions (${maxSubs}) reached`, 409);
  }

  // Fetch target schedule and generate ICS
  const accessToken = await decrypt(user.accessToken!, c.env.ENCRYPTION_KEY);
  const api = new CQUAPIClient(accessToken);

  try {
    const ctx = await fetchSessionContextCached(api, c.env.CACHE);
    const sessionId = ctx.semesterInfo.id ? String(ctx.semesterInfo.id) : "";
    const sessionName = ctx.semesterInfo.name;

    // Check for duplicate with direct query (hits UNIQUE index)
    const duplicate = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.sourceType, body.source_type as SourceType),
          eq(subscriptions.sourceId, body.source_id),
          eq(subscriptions.sessionId, sessionId),
        ),
      )
      .limit(1);

    if (duplicate.length > 0) {
      return errorResponse("SUBSCRIPTION_DUPLICATE", "Subscription already exists for this session", 409);
    }
```

Add `sql` to the import from `drizzle-orm`:

```typescript
import { eq, and, desc, asc, sql } from "drizzle-orm";
```

**Step 2: Run backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All tests pass

**Step 3: Commit**

```
git add src/routes/subscriptions.ts
git commit -m "perf(db): optimize subscription duplicate check to single query

Replace SELECT-all + JS loop with targeted COUNT query for limit
check and direct WHERE query for duplicate check. Both hit indexes.

Part of #66"
```

---

### Task 3: Add Cache-Control Headers

**Files:**
- Modify: `src/routes/subscriptions.ts:54-69` (GET handler)
- Modify: `src/routes/users.ts` (GET /me handler)

**Step 1: Add Cache-Control to GET /subscriptions**

In `src/routes/subscriptions.ts`, the GET handler returns `c.json(...)` around line 54. Change to:

```typescript
  const response = c.json({
    subscriptions: subs.map((sub) => ({
      // ... existing mapping
    })),
    count: subs.length,
    max: Number(c.env.MAX_SUBSCRIPTIONS ?? "10"),
  });
  response.headers.set("Cache-Control", "private, max-age=10");
  return response;
```

**Step 2: Add Cache-Control to GET /users/me**

Find the `GET /me` handler in `src/routes/users.ts`. Add `Cache-Control` header to the response:

```typescript
  const response = c.json({ ... });
  response.headers.set("Cache-Control", "private, max-age=60");
  return response;
```

**Step 3: Run backend tests**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: All tests pass

**Step 4: Commit**

```
git add src/routes/subscriptions.ts src/routes/users.ts
git commit -m "perf(http): add Cache-Control headers to auth endpoints

GET /users/me: private, max-age=60
GET /subscriptions: private, max-age=10

Part of #66"
```

---

### Task 4: Merge Config API Endpoints

**Files:**
- Modify: `src/routes/config.ts`
- Modify: `frontend/src/api/index.ts`
- Modify: `frontend/src/types/api.ts`
- Modify: `frontend/src/stores/config.ts`
- Modify: `frontend/src/App.vue`
- Modify: `frontend/src/api/__tests__/index.test.ts`
- Modify: `frontend/src/stores/__tests__/config.test.ts`

**Step 1: Merge backend config endpoints**

Replace `src/routes/config.ts` entirely:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    commit: c.env.GIT_COMMIT ?? "dev",
    date: c.env.GIT_DATE ?? "unknown",
  });
});

app.get("/config", (c) => {
  const captchaEnabled = c.env.HCAPTCHA_ENABLED === "true";
  const response = c.json({
    public_url: c.env.PUBLIC_URL?.replace(/\/$/, "") ?? "",
    captcha: {
      enabled: captchaEnabled,
      sitekey: captchaEnabled ? (c.env.HCAPTCHA_SITEKEY ?? "") : "",
    },
  });
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
});

export default app;
```

**Step 2: Update frontend types**

In `frontend/src/types/api.ts`, update `AppConfig` and remove `CaptchaConfig`:

```typescript
export interface AppConfig {
  public_url: string
  captcha: {
    enabled: boolean
    sitekey: string
  }
}
```

Remove the standalone `CaptchaConfig` interface. Keep the `CaptchaConfig` type name as an alias if other files import it, or remove all references.

**Step 3: Update frontend API client**

In `frontend/src/api/index.ts`:
- Remove the `getCaptchaConfig` method
- Remove `CaptchaConfig` from the import
- `getConfig` now returns the merged response

```typescript
import type {
  UserInfo,
  SubscriptionList,
  SearchResult,
  AppConfig,
  HealthStatus,
  Subscription,
} from '@/types/api'
```

Remove:
```typescript
  async getCaptchaConfig(): Promise<CaptchaConfig> {
    const response = await client.get('/captcha/config')
    return response.data
  },
```

**Step 4: Update config store**

Replace `frontend/src/stores/config.ts`:

```typescript
import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'

export const useConfigStore = defineStore('config', () => {
  const publicUrl = ref(window.location.origin)
  const loaded = ref(false)
  const captchaEnabled = ref(false)
  const captchaSitekey = ref('')

  async function load() {
    if (loaded.value) return
    try {
      const data = await api.getConfig()
      publicUrl.value = data.public_url
      captchaEnabled.value = data.captcha.enabled
      captchaSitekey.value = data.captcha.sitekey
    } catch {
      // fallback: keep defaults, captcha disabled
    } finally {
      loaded.value = true
    }
  }

  function $reset() {
    publicUrl.value = window.location.origin
    loaded.value = false
    captchaEnabled.value = false
    captchaSitekey.value = ''
  }

  return { publicUrl, loaded, captchaEnabled, captchaSitekey, load, $reset }
})
```

**Step 5: Update App.vue**

In `frontend/src/App.vue`, remove the `loadCaptchaConfig()` call:

```typescript
onMounted(() => {
  configStore.load()
})
```

**Step 6: Update frontend API tests**

In `frontend/src/api/__tests__/index.test.ts`:
- Remove `getCaptchaConfig` from `mockApi` (if used) and its test
- Update the `getConfig` test to no longer exist separately if unchanged, or update path

In the `getCaptchaConfig` describe block (lines 161-169), remove it entirely.

**Step 7: Update config store tests**

In `frontend/src/stores/__tests__/config.test.ts`:
- Remove `getCaptchaConfig` from mockApi
- Update `getConfig` mock to return merged format:
  ```typescript
  mockApi.getConfig.mockResolvedValue({
    public_url: 'https://schedule.cqu.moe',
    captcha: { enabled: true, sitekey: 'test-key' },
  })
  ```
- Add test for captcha fields being set by `load()`
- Remove any `loadCaptchaConfig` tests

**Step 8: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'` (backend)
Run: `npm run test:frontend` (frontend)
Expected: All pass

**Step 9: Commit**

```
git add src/routes/config.ts frontend/src/
git commit -m "perf(api): merge config and captcha endpoints into single GET /config

Reduces frontend startup from 2 API calls to 1.
Adds Cache-Control: public, max-age=300.

Part of #66"
```

---

### Task 5: Add Bundle Analyzer

**Files:**
- Modify: `frontend/package.json` (devDep)
- Modify: `frontend/vite.config.ts`

**Step 1: Install rollup-plugin-visualizer**

Run: `cd frontend && npm install -D rollup-plugin-visualizer`

**Step 2: Configure in vite.config.ts**

Update `frontend/vite.config.ts`:

```typescript
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    ...(process.env.ANALYZE === 'true'
      ? [import('rollup-plugin-visualizer').then(m => m.visualizer({ open: true, filename: 'dist/stats.html' }))]
      : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    port: 5173,
    proxy: {
      '/api/': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  }
})
```

**Step 3: Test build**

Run: `cd frontend && npm run build`
Expected: Build succeeds, no stats.html generated

Run: `cd frontend && ANALYZE=true npm run build`
Expected: Build succeeds, `dist/stats.html` generated and opens in browser

**Step 4: Run frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 5: Commit**

```
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts
git commit -m "perf(frontend): add rollup-plugin-visualizer for bundle analysis

Run with ANALYZE=true npm run build:frontend to generate stats.html.

Part of #66"
```

---

### Task 6: Vite Manual Chunks

**Files:**
- Modify: `frontend/vite.config.ts`

**Step 1: Add manualChunks config**

In `frontend/vite.config.ts`, update the `build` section:

```typescript
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia', 'axios'],
          ui: ['reka-ui', 'lucide-vue-next', 'class-variance-authority', 'clsx', 'tailwind-merge'],
        },
      },
    },
  },
```

**Step 2: Test build**

Run: `cd frontend && npm run build`
Expected: Build succeeds. Output shows separate `vendor-xxx.js` and `ui-xxx.js` chunks.

**Step 3: Run frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 4: Commit**

```
git add frontend/vite.config.ts
git commit -m "perf(frontend): split vendor and UI into separate chunks

vendor: vue, vue-router, pinia, axios
ui: reka-ui, lucide-vue-next, cva, clsx, tailwind-merge

Part of #66"
```

---

### Task 7: Defer hCaptcha Loading

**Files:**
- Modify: `frontend/src/views/Add.vue:116-121`

**Step 1: Add state for deferred captcha mount**

In `Add.vue`, the `<VueHcaptcha>` is currently always rendered when `captchaEnabled` is true (line 116). Change it to only mount when a subscribe action is in progress.

Add a ref in `<script setup>`:

```typescript
const captchaMounted = ref(false)
```

Update `handleSubscribe` to mount captcha before first use:

```typescript
async function handleSubscribe(item: SearchResult) {
  clearError()

  // Mount hCaptcha on first subscribe attempt
  if (captchaEnabled.value && !captchaMounted.value) {
    captchaMounted.value = true
    await nextTick()
  }

  let captchaToken = null
  // ... rest unchanged
```

Add `nextTick` to the import:

```typescript
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
```

Update template (line 116-121):

```html
          <VueHcaptcha
            v-if="captchaEnabled && captchaMounted"
            ref="hcaptchaRef"
            :sitekey="captchaSitekey"
            size="invisible"
          />
```

**Step 2: Run frontend tests**

Run: `npm run test:frontend`
Expected: All pass

**Step 3: Commit**

```
git add frontend/src/views/Add.vue
git commit -m "perf(frontend): defer hCaptcha loading until first subscribe click

Avoids loading hCaptcha iframe on page mount. Component mounts
only when user clicks subscribe and captcha is enabled.

Part of #66"
```

---

### Task 8: @vueuse/core Evaluation & Final Verification

**Step 1: Run bundle analysis**

Run: `cd frontend && ANALYZE=true npm run build`
Expected: `dist/stats.html` opens. Check @vueuse/core bundle size.

**Step 2: Record finding**

If @vueuse/core < 5KB: no action needed, note in commit.
If @vueuse/core > 10KB: create follow-up issue.

**Step 3: Run all tests**

Run: `npx vitest run --exclude 'frontend/**'` (backend)
Run: `npm run test:frontend` (frontend)
Expected: All pass

**Step 4: Verify build**

Run: `cd frontend && npm run build`
Expected: Clean build

**Step 5: Final commit (if any evaluation notes)**

```
git add -A
git commit -m "perf: complete performance optimization (#66)

- DB index on subscriptions(userId)
- Subscription duplicate check: single SQL query
- Cache-Control on /users/me (60s), /subscriptions (10s), /config (300s)
- Merged config + captcha API into single endpoint
- Bundle analyzer (rollup-plugin-visualizer)
- Manual chunks: vendor + UI separation
- Deferred hCaptcha loading

Closes #66"
```

**Step 6: Create PR**

```
gh pr create --title "perf: full-stack performance optimization (#66)" --body "..."
```
