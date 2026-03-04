# Code Deduplication Design

**Date:** 2026-03-04
**Issues:** #24 (backend), #25 (frontend)
**PRs:** Two separate PRs — backend first, frontend second

## Overview

Extract duplicated code into shared utilities, composables, and store actions across backend and frontend. Pure refactoring — no behavior changes.

---

## PR 1: Backend Refactoring (#24)

### 1.1 `bufferToBase64` → `src/utils/encoding.ts`

New file exporting `bufferToBase64(buffer: ArrayBuffer): string`.

- `crypto.ts`: delete private function, import from `utils/encoding`
- `token.ts`: delete inline logic, import
- `ics.ts`: delete inline logic in `generateUid`, import

### 1.2 `CHINA_TZ_OFFSET_MS` unification

`ics.ts` line 3: delete local `const CHINA_TZ_OFFSET_MS`, import from `utils/time.ts`.

### 1.3 `OAUTH_BASIC_AUTH` dynamic computation

`auth.ts` line 149: replace hardcoded base64 with:

```typescript
const OAUTH_BASIC_AUTH = btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`);
```

### 1.4 `calculateCourseEventTime` → `src/utils/time.ts`

Extract from `ics.ts`, generalized signature:

```typescript
export function calculateCourseEventTime(
  termStart: Date,
  week: number,
  dayOfWeek: number,
  timeStr: string, // "HH:MM:SS"
): Date
```

- Caller resolves `timeStr` from `TIME_SLOTS` before calling
- Both `ics.ts` and `export.ts` call this function
- `export.ts` inline time-zone conversion replaced entirely

### 1.5 `spreadEnqueue` → `src/utils/queue.ts`

```typescript
export async function spreadEnqueue<T>(
  queue: Queue<T>,
  items: Array<unknown>,
  mapFn: (item: unknown, index: number) => T,
  spreadSeconds: number,
  minInterval?: number, // default 5
): Promise<void>
```

- BATCH_SIZE=100 internal constant
- `token-refresh.ts`: spreadSeconds=3600, minInterval=5
- `schedule-sync.ts`: spreadSeconds=21600, minInterval=10

### 1.6 `handleCquApiError` → `src/utils/error.ts`

```typescript
export function handleCquApiError(
  c: Context,
  e: unknown,
  fallbackMsg: string,
): Response
```

- Unified `instanceof CQUAPIError` check (fixes subscriptions.ts inconsistency)
- 401 → `{ detail: "CQU token expired, please re-login" }` (401)
- Other CQUAPIError → `{ detail: e.message }` (502)
- Non-CQUAPIError → `{ detail: fallbackMsg }` (502)

### 1.7 Credential parsing → `src/routes/users.ts` internal helpers

Two helpers at top of `users.ts`:

```typescript
async function requireCaptcha(c: Context<{ Bindings: Env }>): Promise<Response | null>
// Returns null on success, error Response on failure

async function parseCredentials(c: Context): Promise<{ student_id: string; password: string } | Response>
// Returns parsed body or error Response
```

Usage pattern in all 3 endpoints:

```typescript
const captchaErr = await requireCaptcha(c);
if (captchaErr) return captchaErr;
const result = await parseCredentials(c);
if (result instanceof Response) return result;
const { student_id, password } = result;
```

---

## PR 2: Frontend Refactoring (#25)

### 2.1 Captcha config → extend Pinia config store

Extend `frontend/src/stores/config.js`:

- State: `captchaEnabled: false`, `captchaSitekey: ''`
- Action: `loadCaptchaConfig()` — calls `api.getCaptchaConfig()`, silently degrades on failure
- Called once in `App.vue` `onMounted`

### 2.2 `useCaptcha()` → `frontend/src/composables/useCaptcha.ts`

```typescript
export function useCaptcha() {
  const configStore = useConfigStore()
  const hcaptchaRef = ref(null)

  async function getCaptchaToken(): Promise<string | null> {
    if (!configStore.captchaEnabled || !hcaptchaRef.value) return null
    const { response } = await hcaptchaRef.value.executeAsync()
    return response
  }

  return {
    hcaptchaRef,
    captchaEnabled: computed(() => configStore.captchaEnabled),
    captchaSitekey: computed(() => configStore.captchaSitekey),
    getCaptchaToken,
  }
}
```

Register, Recover, Add views delete local captcha logic and use composable. Callers handle `getCaptchaToken()` errors themselves.

### 2.3 Subscriptions → Pinia store

New `frontend/src/stores/subscriptions.js`:

- State: `subscriptions: []`, `subscriptionsMax: 5`
- Action: `loadSubscriptions()` — calls `api.getSubscriptions(authStore.token)`

Dashboard and Add views use `useSubscriptionsStore()`.

### 2.4 `useRiskWarning()` → `frontend/src/composables/useRiskWarning.ts`

```typescript
export function useRiskWarning() {
  const showRiskWarning = ref(
    !localStorage.getItem('risk_warning_acknowledged')
  )
  return { showRiskWarning }
}
```

4 views (Login, Register, Recover, Dashboard) delete `onMounted` localStorage check and `showRiskWarning` ref, use composable instead.

### 2.5 `buildOPSaveValue` → `frontend/src/utils/opSave.ts`

```typescript
export function buildOPSaveValue(token: string): string {
  const configStore = useConfigStore()
  return encodeOPSaveRequest({
    title: 'CQU Schedule',
    fields: [{ autocomplete: 'current-password', value: token }],
    urls: [configStore.publicUrl],
  })
}
```

Register and Recover use `buildOPSaveValue(token)`. Hardcoded URL replaced with `configStore.publicUrl`.

### 2.6 `copyToken` — not extracted

Only 2 usages, 5 lines each. Existing `useButtonFeedback` composable already covers similar patterns. Not worth a separate abstraction.

---

## Testing Strategy

**Backend:** Existing vitest tests cover all affected paths. Run `npm test` to verify no regressions. Add unit tests for new utility functions (`spreadEnqueue`, `handleCquApiError`, `calculateCourseEventTime`, `bufferToBase64`).

**Frontend:** Run `npm run test:frontend`. Update existing view tests if mocking patterns change (e.g., captcha config now from store instead of API call). Add tests for new composables.

## Risks

- **Event time calculation:** The `export.ts` inline version lacks session validation that `ics.ts` has. The shared function takes `timeStr` directly, so validation is caller's responsibility — same as current `export.ts` behavior.
- **Captcha store timing:** If a view mounts before `App.vue` finishes loading captcha config, the composable returns `captchaEnabled: false` which is the correct degraded behavior.
