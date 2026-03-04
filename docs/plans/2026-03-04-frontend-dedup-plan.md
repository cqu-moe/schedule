# Frontend Code Deduplication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract 5 duplicated patterns in frontend code into composables, store actions, and utility functions.

**Architecture:** Extend Pinia stores for shared state (captcha config, subscriptions), create composables for shared reactive logic (captcha token, risk warning), and extract utility helpers (1Password save). Pure refactoring — no behavior changes.

**Tech Stack:** Vue 3 (Composition API), Pinia, Tailwind v4, shadcn-vue, vitest v4 + jsdom

---

### Task 1: Extend config store with captcha config

**Files:**
- Modify: `frontend/src/stores/config.js`
- Modify: `frontend/src/App.vue`
- Create: `frontend/src/stores/__tests__/config-captcha.test.ts`

**Step 1: Write the test**

```typescript
// frontend/src/stores/__tests__/config-captcha.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfigStore } from '../config.js'

const mockApi = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getCaptchaConfig: vi.fn(),
}))

vi.mock('@/api/index.js', () => ({ default: mockApi }))

describe('config store captcha', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('initializes captcha as disabled', () => {
    const store = useConfigStore()
    expect(store.captchaEnabled).toBe(false)
    expect(store.captchaSitekey).toBe('')
  })

  it('loads captcha config successfully', async () => {
    mockApi.getCaptchaConfig.mockResolvedValue({ enabled: true, sitekey: 'test-key' })
    const store = useConfigStore()
    await store.loadCaptchaConfig()
    expect(store.captchaEnabled).toBe(true)
    expect(store.captchaSitekey).toBe('test-key')
  })

  it('silently degrades on captcha config load failure', async () => {
    mockApi.getCaptchaConfig.mockRejectedValue(new Error('Network error'))
    const store = useConfigStore()
    await store.loadCaptchaConfig()
    expect(store.captchaEnabled).toBe(false)
    expect(store.captchaSitekey).toBe('')
  })

  it('only loads captcha config once', async () => {
    mockApi.getCaptchaConfig.mockResolvedValue({ enabled: true, sitekey: 'test-key' })
    const store = useConfigStore()
    await store.loadCaptchaConfig()
    await store.loadCaptchaConfig()
    expect(mockApi.getCaptchaConfig).toHaveBeenCalledTimes(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/stores/__tests__/config-captcha.test.ts`
Expected: FAIL — `loadCaptchaConfig` not found

**Step 3: Modify config store**

```javascript
// frontend/src/stores/config.js
import { defineStore } from 'pinia'
import api from '@/api/index.js'

export const useConfigStore = defineStore('config', {
  state: () => ({
    publicUrl: window.location.origin,
    loaded: false,
    captchaEnabled: false,
    captchaSitekey: '',
    captchaLoaded: false,
  }),

  actions: {
    async load() {
      if (this.loaded) return
      try {
        const data = await api.getConfig()
        this.publicUrl = data.public_url
      } catch {
        // fallback: keep window.location.origin
      } finally {
        this.loaded = true
      }
    },

    async loadCaptchaConfig() {
      if (this.captchaLoaded) return
      try {
        const config = await api.getCaptchaConfig()
        this.captchaEnabled = config.enabled
        this.captchaSitekey = config.sitekey
      } catch {
        // Proceed without captcha — graceful degradation
      } finally {
        this.captchaLoaded = true
      }
    },
  },
})
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/stores/__tests__/config-captcha.test.ts`
Expected: PASS

**Step 5: Load captcha config in App.vue**

In `frontend/src/App.vue`, modify `onMounted`:

```javascript
onMounted(() => {
  configStore.load()
  configStore.loadCaptchaConfig()
})
```

**Step 6: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: All PASS (existing config.test.ts still passes — new state defaults don't break anything)

**Step 7: Commit**

```
refactor(frontend): add captcha config to Pinia config store
```

---

### Task 2: Create `useCaptcha` composable

**Files:**
- Create: `frontend/src/composables/useCaptcha.ts`
- Create: `frontend/src/composables/__tests__/useCaptcha.test.ts`
- Modify: `frontend/src/views/Register.vue`
- Modify: `frontend/src/views/Recover.vue`
- Modify: `frontend/src/views/Add.vue`

**Step 1: Write the test**

```typescript
// frontend/src/composables/__tests__/useCaptcha.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCaptcha } from '../useCaptcha'

vi.mock('@/api/index.js', () => ({
  default: { getCaptchaConfig: vi.fn(), getConfig: vi.fn() },
}))

describe('useCaptcha', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('exposes hcaptchaRef and config from store', () => {
    const { hcaptchaRef, captchaEnabled, captchaSitekey } = useCaptcha()
    expect(hcaptchaRef.value).toBeNull()
    expect(captchaEnabled.value).toBe(false)
    expect(captchaSitekey.value).toBe('')
  })

  it('getCaptchaToken returns null when captcha disabled', async () => {
    const { getCaptchaToken } = useCaptcha()
    const token = await getCaptchaToken()
    expect(token).toBeNull()
  })

  it('getCaptchaToken returns null when hcaptchaRef is null', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    // Even if enabled, no ref means no token
    const { getCaptchaToken } = useCaptcha()
    const token = await getCaptchaToken()
    expect(token).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/composables/__tests__/useCaptcha.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// frontend/src/composables/useCaptcha.ts
import { ref, computed } from 'vue'
import { useConfigStore } from '@/stores/config.js'

export function useCaptcha() {
  const configStore = useConfigStore()
  const hcaptchaRef = ref<any>(null)

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

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/composables/__tests__/useCaptcha.test.ts`
Expected: PASS

**Step 5: Refactor Register.vue**

In `<script setup>`:

Remove:
```javascript
const captchaEnabled = ref(false)
const captchaSitekey = ref('')
const hcaptchaRef = ref(null)
```

Add:
```javascript
import { useCaptcha } from '@/composables/useCaptcha'
const { hcaptchaRef, captchaEnabled, captchaSitekey, getCaptchaToken } = useCaptcha()
```

Remove from `onMounted`:
```javascript
try {
  const config = await api.getCaptchaConfig()
  captchaEnabled.value = config.enabled
  captchaSitekey.value = config.sitekey
} catch {
  // Proceed without captcha — graceful degradation
}
```

Replace captcha token logic in `handleRegister` (lines 174-183):
```javascript
let captchaToken = null
try {
  captchaToken = await getCaptchaToken()
} catch {
  errorMessage.value = '验证码加载失败，请刷新页面重试'
  return
}
```

**Step 6: Refactor Recover.vue**

Same pattern — remove local refs and `getCaptchaToken` function, use composable.

Remove:
```javascript
const captchaEnabled = ref(false)
const captchaSitekey = ref('')
const hcaptchaRef = ref(null)
```
and the local `getCaptchaToken()` function (lines 150-159).

Add:
```javascript
import { useCaptcha } from '@/composables/useCaptcha'
const { hcaptchaRef, captchaEnabled, captchaSitekey, getCaptchaToken: getCaptchaTokenRaw } = useCaptcha()
```

Replace `getCaptchaToken()` calls in `handleRecover` and `handleVerify`. The callers still need error handling:
```javascript
async function handleRecover() {
  errorMessage.value = ''
  if (!form.studentId) { errorMessage.value = '请输入统一身份认证号'; return }
  if (!form.password) { errorMessage.value = '请输入密码'; return }

  let captchaToken
  try {
    captchaToken = await getCaptchaTokenRaw()
  } catch {
    errorMessage.value = '验证码加载失败，请刷新页面重试'
    return
  }
  // ... rest unchanged
}
```

Same for `handleVerify`.

Remove captcha config loading from `onMounted`.

**Step 7: Refactor Add.vue**

Remove:
```javascript
const captchaEnabled = ref(false)
const captchaSitekey = ref('')
const hcaptchaRef = ref(null)
```

Add:
```javascript
import { useCaptcha } from '@/composables/useCaptcha'
const { hcaptchaRef, captchaEnabled, captchaSitekey, getCaptchaToken } = useCaptcha()
```

Replace captcha token logic in `handleSubscribe` (lines 294-303):
```javascript
let captchaToken = null
try {
  captchaToken = await getCaptchaToken()
} catch {
  errorMessage.value = '验证码加载失败，请刷新页面重试'
  return
}
```

Remove captcha config loading from `onMounted`.

**Step 8: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: All PASS

**Step 9: Commit**

```
refactor(frontend): extract useCaptcha composable from views
```

---

### Task 3: Create subscriptions Pinia store

**Files:**
- Create: `frontend/src/stores/subscriptions.js`
- Create: `frontend/src/stores/__tests__/subscriptions.test.ts`
- Modify: `frontend/src/views/Dashboard.vue`
- Modify: `frontend/src/views/Add.vue`

**Step 1: Write the test**

```typescript
// frontend/src/stores/__tests__/subscriptions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockApi = vi.hoisted(() => ({
  getSubscriptions: vi.fn(),
}))

vi.mock('@/api/index.js', () => ({ default: mockApi }))

// Must mock auth store before importing subscriptions store
vi.mock('@/stores/auth.js', () => ({
  useAuthStore: () => ({ token: 'test-token' }),
}))

import { useSubscriptionsStore } from '../subscriptions.js'

describe('subscriptions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('initializes with empty state', () => {
    const store = useSubscriptionsStore()
    expect(store.subscriptions).toEqual([])
    expect(store.max).toBe(5)
  })

  it('loads subscriptions from API', async () => {
    const mockSubs = [{ calendar_token: 'abc', source_type: 'personal_all' }]
    mockApi.getSubscriptions.mockResolvedValue({ subscriptions: mockSubs, max: 10 })
    const store = useSubscriptionsStore()
    await store.load()
    expect(store.subscriptions).toEqual(mockSubs)
    expect(store.max).toBe(10)
    expect(mockApi.getSubscriptions).toHaveBeenCalledWith('test-token')
  })

  it('does not clear state on load failure', async () => {
    mockApi.getSubscriptions.mockResolvedValueOnce({ subscriptions: [{ id: '1' }], max: 5 })
    const store = useSubscriptionsStore()
    await store.load()
    expect(store.subscriptions).toHaveLength(1)

    mockApi.getSubscriptions.mockRejectedValueOnce(new Error('fail'))
    await expect(store.load()).rejects.toThrow('fail')
    expect(store.subscriptions).toHaveLength(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/stores/__tests__/subscriptions.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```javascript
// frontend/src/stores/subscriptions.js
import { defineStore } from 'pinia'
import api from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'

export const useSubscriptionsStore = defineStore('subscriptions', {
  state: () => ({
    subscriptions: [],
    max: 5,
  }),

  actions: {
    async load() {
      const authStore = useAuthStore()
      const data = await api.getSubscriptions(authStore.token)
      this.subscriptions = data.subscriptions
      this.max = data.max
    },
  },
})
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/stores/__tests__/subscriptions.test.ts`
Expected: PASS

**Step 5: Refactor Dashboard.vue**

Add import:
```javascript
import { useSubscriptionsStore } from '@/stores/subscriptions.js'
const subStore = useSubscriptionsStore()
```

Remove:
```javascript
const subscriptions = ref([])
const subscriptionsMax = ref(5)
```
and the `loadSubscriptions` function.

Replace all `subscriptions.value` with `subStore.subscriptions` and `subscriptionsMax.value` with `subStore.max`.

Replace `loadSubscriptions()` calls with `subStore.load()`.

The `hasPendingSubs` computed needs adjustment:
```javascript
const hasPendingSubs = computed(() =>
  subStore.subscriptions.some(s => s.is_personal && !s.last_synced_at)
)
```

**Step 6: Refactor Add.vue**

Add import:
```javascript
import { useSubscriptionsStore } from '@/stores/subscriptions.js'
const subStore = useSubscriptionsStore()
```

Remove:
```javascript
const subscriptions = ref([])
const subscriptionsMax = ref(5)
```
and the `loadSubscriptions` function.

Replace all `subscriptions.value` with `subStore.subscriptions` and `subscriptionsMax.value` with `subStore.max`.

In `onMounted`:
```javascript
try {
  await subStore.load()
} catch {
  toast.error('加载订阅列表失败')
}
```

In `handleSubscribe`:
```javascript
await subStore.load().catch(() => {})
```

In `isSubscribed`:
```javascript
function isSubscribed(sourceId) {
  return subStore.subscriptions.some(
    s => s.source_id === sourceId && s.source_type === sourceType.value
  )
}
```

**Step 7: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: All PASS — existing Dashboard/Add tests may need minor mock updates for the store

**Step 8: Commit**

```
refactor(frontend): extract subscriptions to Pinia store
```

---

### Task 4: Create `useRiskWarning` composable

**Files:**
- Create: `frontend/src/composables/useRiskWarning.ts`
- Create: `frontend/src/composables/__tests__/useRiskWarning.test.ts`
- Modify: `frontend/src/views/Login.vue`
- Modify: `frontend/src/views/Register.vue`
- Modify: `frontend/src/views/Recover.vue`
- Modify: `frontend/src/views/Dashboard.vue`

**Step 1: Write the test**

```typescript
// frontend/src/composables/__tests__/useRiskWarning.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useRiskWarning } from '../useRiskWarning'

describe('useRiskWarning', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows warning when not acknowledged', () => {
    const { showRiskWarning } = useRiskWarning()
    expect(showRiskWarning.value).toBe(true)
  })

  it('hides warning when already acknowledged', () => {
    localStorage.setItem('risk_warning_acknowledged', 'true')
    const { showRiskWarning } = useRiskWarning()
    expect(showRiskWarning.value).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/composables/__tests__/useRiskWarning.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// frontend/src/composables/useRiskWarning.ts
import { ref } from 'vue'

export function useRiskWarning() {
  const showRiskWarning = ref(
    !localStorage.getItem('risk_warning_acknowledged')
  )
  return { showRiskWarning }
}
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/composables/__tests__/useRiskWarning.test.ts`
Expected: PASS

**Step 5: Refactor all 4 views**

In each view (Login.vue, Register.vue, Recover.vue, Dashboard.vue):

Add:
```javascript
import { useRiskWarning } from '@/composables/useRiskWarning'
const { showRiskWarning } = useRiskWarning()
```

Remove:
```javascript
const showRiskWarning = ref(false)
```

Remove from `onMounted`:
```javascript
if (!localStorage.getItem('risk_warning_acknowledged')) {
  showRiskWarning.value = true
}
```

For Login.vue, the `onMounted` block becomes empty and can be removed entirely.

For Dashboard.vue, the `onMounted` still has subscriptions loading — just remove the risk warning part.

**Step 6: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: All PASS

**Step 7: Commit**

```
refactor(frontend): extract useRiskWarning composable
```

---

### Task 5: Extract `buildOPSaveValue` helper

**Files:**
- Create: `frontend/src/utils/opSave.ts`
- Create: `frontend/src/utils/__tests__/opSave.test.ts`
- Modify: `frontend/src/views/Register.vue`
- Modify: `frontend/src/views/Recover.vue`

**Step 1: Write the test**

```typescript
// frontend/src/utils/__tests__/opSave.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockEncode = vi.hoisted(() => vi.fn(() => 'encoded-value'))
vi.mock('@1password/save-button', () => ({
  encodeOPSaveRequest: mockEncode,
  activateOPButton: vi.fn(),
}))

vi.mock('@/api/index.js', () => ({
  default: { getConfig: vi.fn() },
}))

import { useConfigStore } from '@/stores/config.js'
import { buildOPSaveValue } from '../opSave'

describe('buildOPSaveValue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('encodes OP save request with config store publicUrl', () => {
    const configStore = useConfigStore()
    configStore.publicUrl = 'https://schedule.cqu.moe'

    const result = buildOPSaveValue('my-token')
    expect(result).toBe('encoded-value')
    expect(mockEncode).toHaveBeenCalledWith({
      title: 'CQU Schedule',
      fields: [{ autocomplete: 'current-password', value: 'my-token' }],
      urls: ['https://schedule.cqu.moe'],
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/utils/__tests__/opSave.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// frontend/src/utils/opSave.ts
import { encodeOPSaveRequest } from '@1password/save-button'
import { useConfigStore } from '@/stores/config.js'

export function buildOPSaveValue(token: string): string {
  const configStore = useConfigStore()
  return encodeOPSaveRequest({
    title: 'CQU Schedule',
    fields: [{ autocomplete: 'current-password', value: token }],
    urls: [configStore.publicUrl],
  })
}
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/utils/__tests__/opSave.test.ts`
Expected: PASS

**Step 5: Refactor Register.vue**

Add import:
```javascript
import { buildOPSaveValue } from '@/utils/opSave'
```

Remove `encodeOPSaveRequest` from `@1password/save-button` import (keep `activateOPButton`).

Replace in `handleRegister`:
```javascript
opSaveValue.value = buildOPSaveValue(result.token)
```

**Step 6: Refactor Recover.vue**

Add import:
```javascript
import { buildOPSaveValue } from '@/utils/opSave'
```

Remove `encodeOPSaveRequest` from `@1password/save-button` import (keep `activateOPButton`).

Replace in `handleRecover`:
```javascript
opSaveValue.value = buildOPSaveValue(data.calendar_token)
```

Replace in `handleVerify`:
```javascript
opSaveValue.value = buildOPSaveValue(data.calendar_token)
```

**Step 7: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: All PASS

**Step 8: Commit**

```
refactor(frontend): extract buildOPSaveValue helper
```

---

### Task 6: Final verification and PR

**Step 1: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors

**Step 2: Run full frontend tests**

Run: `cd frontend && npm test`
Expected: All tests PASS

**Step 3: Review changes**

Run: `git diff --stat main`
Verify:
- New files: `frontend/src/composables/useCaptcha.ts`, `frontend/src/composables/useRiskWarning.ts`, `frontend/src/composables/__tests__/useCaptcha.test.ts`, `frontend/src/composables/__tests__/useRiskWarning.test.ts`, `frontend/src/stores/subscriptions.js`, `frontend/src/stores/__tests__/subscriptions.test.ts`, `frontend/src/stores/__tests__/config-captcha.test.ts`, `frontend/src/utils/opSave.ts`, `frontend/src/utils/__tests__/opSave.test.ts`
- Modified: `frontend/src/stores/config.js`, `frontend/src/App.vue`, `frontend/src/views/Register.vue`, `frontend/src/views/Recover.vue`, `frontend/src/views/Add.vue`, `frontend/src/views/Dashboard.vue`, `frontend/src/views/Login.vue`

**Step 4: Create PR**

```bash
gh pr create --title "refactor: extract frontend composables and stores (#25)" \
  --body "Closes #25"
```
