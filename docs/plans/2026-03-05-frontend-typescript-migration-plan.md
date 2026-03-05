# Frontend TypeScript Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate 6 core frontend `.js` files to TypeScript, add API/store types, unify stores to Composition API.

**Architecture:** Create shared type definitions, then migrate files bottom-up by dependency order. Existing tests serve as regression suite — no new test files needed, just update imports and add types to test-utils.

**Tech Stack:** TypeScript, Vue 3, Pinia, Vue Router, Axios, Vitest

---

### Task 1: Create API type definitions

**Files:**
- Create: `frontend/src/types/api.ts`

**Step 1: Create the types file**

```ts
export interface UserInfo {
  student_id: string
  calendar_token: string
  oauth_expires_at: string
  last_synced_at: string | null
}

export interface Subscription {
  calendar_token: string
  source_type: string
  source_id: string
  source_name: string
  is_personal: boolean
  session_name: string
  last_synced_at: string | null
  subscription_url: string
}

export interface SubscriptionList {
  subscriptions: Subscription[]
  max: number
}

export interface SearchResult {
  id: string
  name: string
  extra: string
}

export interface CaptchaConfig {
  enabled: boolean
  sitekey: string
}

export interface AppConfig {
  public_url: string
}

export interface HealthStatus {
  status: string
}

export interface AuthResult {
  success: boolean
  token?: string
  error?: string
}
```

**Step 2: Verify build**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -v 'tsconfig.node.json' | tail -5`
Expected: No new errors (pre-existing tsconfig.node.json errors are OK)

**Step 3: Commit**

```bash
git add frontend/src/types/api.ts
git commit -m "refactor(frontend): add API type definitions (#37)"
```

---

### Task 2: Migrate API client to TypeScript

**Files:**
- Rename: `frontend/src/api/index.js` -> `frontend/src/api/index.ts`
- Modify: `frontend/src/api/__tests__/index.test.ts` (line 24: update import path)

**Step 1: Rename and add types**

Rename `frontend/src/api/index.js` to `frontend/src/api/index.ts`. Update contents:

```ts
import axios, { type AxiosError } from 'axios'
import type {
  UserInfo,
  SubscriptionList,
  SearchResult,
  CaptchaConfig,
  AppConfig,
  HealthStatus,
  Subscription,
} from '@/types/api'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

client.interceptors.response.use(undefined, (error: AxiosError) => {
  if (error.response?.status === 429 && !(error.response?.data as Record<string, unknown>)?.detail) {
    error.response.data = { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } }
  }
  return Promise.reject(error)
})

const authHeaders = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

export default {
  // 用户相关
  async register(studentId: string, password: string, captchaToken: string | null = null): Promise<UserInfo> {
    const headers: Record<string, string> = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users', {
      student_id: studentId,
      password: password
    }, { headers, timeout: 120000 })
    return response.data
  },

  async recoverToken(studentId: string, password: string, captchaToken: string | null = null): Promise<UserInfo> {
    const headers: Record<string, string> = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users/recover', {
      student_id: studentId,
      password: password
    }, { headers })
    return response.data
  },

  async recoverTokenVerify(studentId: string, password: string, captchaToken: string | null = null): Promise<UserInfo> {
    const headers: Record<string, string> = {}
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const response = await client.post('/users/recover/verify', {
      student_id: studentId,
      password: password
    }, { headers, timeout: 120000 })
    return response.data
  },

  async getCaptchaConfig(): Promise<CaptchaConfig> {
    const response = await client.get('/captcha/config')
    return response.data
  },

  async getUserInfo(token: string): Promise<UserInfo> {
    const response = await client.get('/users/me', authHeaders(token))
    return response.data
  },

  async deleteUser(token: string): Promise<void> {
    await client.delete('/users/me', authHeaders(token))
  },

  // 搜索相关
  async searchSchedule(token: string, sourceType: string, keyword: string, departmentId = '', grade = ''): Promise<SearchResult[]> {
    const params = new URLSearchParams({ source_type: sourceType, keyword })
    if (departmentId) params.append('department_id', departmentId)
    if (grade) params.append('grade', grade)
    const response = await client.get(`/search?${params}`, authHeaders(token))
    return response.data
  },

  async getDepartments(token: string): Promise<SearchResult[]> {
    const response = await client.get('/departments', authHeaders(token))
    return response.data
  },

  // 订阅管理
  async createSubscription(token: string, sourceType: string, sourceId: string, sourceName: string, captchaToken: string | null = null): Promise<Subscription> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken
    const body = {
      source_type: sourceType,
      source_id: sourceId,
      source_name: sourceName,
    }
    const response = await client.post('/subscriptions', body, { headers, timeout: 120000 })
    return response.data
  },

  async getSubscriptions(token: string): Promise<SubscriptionList> {
    const response = await client.get('/subscriptions', authHeaders(token))
    return response.data
  },

  async deleteSubscription(token: string, subToken: string): Promise<void> {
    await client.delete(`/subscriptions/${subToken}`, authHeaders(token))
  },

  async refreshSubscription(token: string, subToken: string): Promise<Subscription> {
    const response = await client.post(`/subscriptions/${subToken}/refresh`, null, { ...authHeaders(token), timeout: 120000 })
    return response.data
  },

  async getHealth(): Promise<HealthStatus> {
    const response = await client.get('/health')
    return response.data
  },

  async getConfig(): Promise<AppConfig> {
    const response = await client.get('/config')
    return response.data
  },
}
```

**Step 2: Update API test import**

In `frontend/src/api/__tests__/index.test.ts`, line 24:
```ts
// Before:
import api from '../index.js'
// After:
import api from '../index'
```

**Step 3: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 4: Commit**

```bash
git add frontend/src/api/index.ts frontend/src/api/__tests__/index.test.ts
# The old .js file deletion is handled by git detecting the rename
git commit -m "refactor(frontend): migrate API client to TypeScript (#37)"
```

---

### Task 3: Migrate config store to TypeScript + Composition API

**Files:**
- Rename: `frontend/src/stores/config.js` -> `frontend/src/stores/config.ts`
- Modify: `frontend/src/stores/__tests__/config.test.ts` (update import paths + remove redundant mock)

**Step 1: Rename and rewrite as Composition API**

Rename `frontend/src/stores/config.js` to `frontend/src/stores/config.ts`:

```ts
import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'

export const useConfigStore = defineStore('config', () => {
  const publicUrl = ref(window.location.origin)
  const loaded = ref(false)
  const captchaEnabled = ref(false)
  const captchaSitekey = ref('')
  const captchaLoaded = ref(false)

  async function load() {
    if (loaded.value) return
    try {
      const data = await api.getConfig()
      publicUrl.value = data.public_url
    } catch {
      // fallback: keep window.location.origin
    } finally {
      loaded.value = true
    }
  }

  async function loadCaptchaConfig() {
    if (captchaLoaded.value) return
    try {
      const config = await api.getCaptchaConfig()
      captchaEnabled.value = config.enabled
      captchaSitekey.value = config.sitekey
      captchaLoaded.value = true
    } catch {
      // Proceed without captcha — graceful degradation
      // Don't set captchaLoaded so it can be retried
    }
  }

  function $reset() {
    publicUrl.value = window.location.origin
    loaded.value = false
    captchaEnabled.value = false
    captchaSitekey.value = ''
    captchaLoaded.value = false
  }

  return { publicUrl, loaded, captchaEnabled, captchaSitekey, captchaLoaded, load, loadCaptchaConfig, $reset }
})
```

**Step 2: Update config test**

In `frontend/src/stores/__tests__/config.test.ts`:

1. Remove line 7 comment and line 9 (`vi.mock('@/api/index.js', ...)`), since the store now imports `@/api` not `@/api/index.js`
2. Update all `await import('@/stores/config.js')` to `await import('@/stores/config')` (lines 19, 29, 41, 55)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createMockApi } from '@/test-utils'

const mockApi = createMockApi()

vi.mock('@/api', () => ({ default: mockApi }))

describe('config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi.getConfig.mockReset()
  })

  it('defaults publicUrl to window.location.origin', async () => {
    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    expect(store.publicUrl).toBe(window.location.origin)
    expect(store.loaded).toBe(false)
  })

  it('load() fetches and sets publicUrl', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    await store.load()

    expect(mockApi.getConfig).toHaveBeenCalledOnce()
    expect(store.publicUrl).toBe('https://schedule.cqu.moe')
    expect(store.loaded).toBe(true)
  })

  it('load() keeps default publicUrl on error', async () => {
    mockApi.getConfig.mockRejectedValue(new Error('Network error'))

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()
    const originalUrl = store.publicUrl

    await store.load()

    expect(store.publicUrl).toBe(originalUrl)
    expect(store.loaded).toBe(true)
  })

  it('load() only calls API once', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })

    const { useConfigStore } = await import('@/stores/config')
    const store = useConfigStore()

    await store.load()
    await store.load()
    await store.load()

    expect(mockApi.getConfig).toHaveBeenCalledOnce()
  })
})
```

**Step 3: Update consumers that import `@/stores/config.js`**

These files reference `@/stores/config.js` and need the `.js` removed:
- `frontend/src/App.vue` — change `from '@/stores/config.js'` to `from '@/stores/config'`
- `frontend/src/views/Docs.vue` — same
- `frontend/src/views/Dashboard.vue` — same
- `frontend/src/composables/useCaptcha.ts` — same
- `frontend/src/utils/opSave.ts` — same

**Step 4: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 5: Commit**

```bash
git add frontend/src/stores/config.ts frontend/src/stores/__tests__/config.test.ts \
  frontend/src/App.vue frontend/src/views/Docs.vue frontend/src/views/Dashboard.vue \
  frontend/src/composables/useCaptcha.ts frontend/src/utils/opSave.ts
git commit -m "refactor(frontend): migrate config store to TypeScript + Composition API (#37)"
```

---

### Task 4: Migrate subscriptions store to TypeScript + Composition API

**Files:**
- Rename: `frontend/src/stores/subscriptions.js` -> `frontend/src/stores/subscriptions.ts`

**Step 1: Rename and rewrite as Composition API**

Rename `frontend/src/stores/subscriptions.js` to `frontend/src/stores/subscriptions.ts`:

```ts
import { ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Subscription } from '@/types/api'

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const subscriptions = ref<Subscription[]>([])
  const max = ref(5)

  async function load() {
    const authStore = useAuthStore()
    const data = await api.getSubscriptions(authStore.token)
    subscriptions.value = data.subscriptions
    max.value = data.max
  }

  function $reset() {
    subscriptions.value = []
    max.value = 5
  }

  return { subscriptions, max, load, $reset }
})
```

**Step 2: Update consumers that import `@/stores/subscriptions.js`**

These files reference `@/stores/subscriptions.js` and need the `.js` removed:
- `frontend/src/views/Dashboard.vue` — change `from '@/stores/subscriptions.js'` to `from '@/stores/subscriptions'`
- `frontend/src/views/Add.vue` — same

**Step 3: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 4: Commit**

```bash
git add frontend/src/stores/subscriptions.ts \
  frontend/src/views/Dashboard.vue frontend/src/views/Add.vue
git commit -m "refactor(frontend): migrate subscriptions store to TypeScript + Composition API (#37)"
```

---

### Task 5: Migrate auth store to TypeScript

**Files:**
- Rename: `frontend/src/stores/auth.js` -> `frontend/src/stores/auth.ts`

**Step 1: Rename and add types**

Rename `frontend/src/stores/auth.js` to `frontend/src/stores/auth.ts`:

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api'
import { parseApiError } from '@/utils/error'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import type { UserInfo, AuthResult } from '@/types/api'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('calendar_token') || '')
  const userInfo = ref<UserInfo | null>(null)
  const loading = ref(false)

  const isAuthenticated = computed(() => !!token.value)

  async function register(studentId: string, password: string, captchaToken: string | null = null): Promise<AuthResult> {
    loading.value = true
    try {
      const response = await api.register(studentId, password, captchaToken)
      token.value = response.calendar_token
      localStorage.setItem('calendar_token', token.value)
      return { success: true, token: response.calendar_token }
    } catch (error) {
      return { success: false, error: parseApiError(error, '注册失败') }
    } finally {
      loading.value = false
    }
  }

  async function loginWithToken(calendarToken: string): Promise<AuthResult> {
    loading.value = true
    try {
      const response = await api.getUserInfo(calendarToken)
      token.value = calendarToken
      userInfo.value = response
      localStorage.setItem('calendar_token', token.value)
      return { success: true }
    } catch (error) {
      return { success: false, error: parseApiError(error, 'Token 无效或已过期') }
    } finally {
      loading.value = false
    }
  }

  async function fetchUserInfo() {
    if (!token.value) return
    try {
      userInfo.value = await api.getUserInfo(token.value)
    } catch {
      logout()
    }
  }

  function logout() {
    token.value = ''
    userInfo.value = null
    localStorage.removeItem('calendar_token')
    // Clear shared stores to prevent cross-session data leakage
    useSubscriptionsStore().$reset()
  }

  // 初始化时检查 token 有效性
  if (token.value) {
    fetchUserInfo()
  }

  return {
    token,
    userInfo,
    loading,
    isAuthenticated,
    register,
    loginWithToken,
    fetchUserInfo,
    logout
  }
})
```

Note: `@/stores/auth` is already used without `.js` extension by most consumers (router, views, Navbar, tests). The only file that imported `@/stores/auth.js` with extension was `subscriptions.js`, which was already fixed in Task 4.

**Step 2: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 3: Commit**

```bash
git add frontend/src/stores/auth.ts
git commit -m "refactor(frontend): migrate auth store to TypeScript (#37)"
```

---

### Task 6: Migrate router to TypeScript with route name constants

**Files:**
- Rename: `frontend/src/router/index.js` -> `frontend/src/router/index.ts`
- Modify: `frontend/src/router/__tests__/index.test.ts` (line 24: update import path)

**Step 1: Rename and add route name constants**

Rename `frontend/src/router/index.js` to `frontend/src/router/index.ts`:

```ts
import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export const RouteNames = {
  Home: 'Home',
  Login: 'Login',
  Register: 'Register',
  Recover: 'Recover',
  Dashboard: 'Dashboard',
  Add: 'Add',
  ApiDocs: 'ApiDocs',
} as const

const routes = [
  {
    path: '/',
    name: RouteNames.Home,
    component: () => import('@/views/Home.vue')
  },
  {
    path: '/login',
    name: RouteNames.Login,
    component: () => import('@/views/Login.vue')
  },
  {
    path: '/register',
    name: RouteNames.Register,
    component: () => import('@/views/Register.vue')
  },
  {
    path: '/recover',
    name: RouteNames.Recover,
    component: () => import('@/views/Recover.vue')
  },
  {
    path: '/dashboard',
    name: RouteNames.Dashboard,
    component: () => import('@/views/Dashboard.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/add',
    name: RouteNames.Add,
    component: () => import('@/views/Add.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/api-docs',
    name: RouteNames.ApiDocs,
    component: () => import('@/views/Docs.vue')
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// 路由守卫
router.beforeEach((to, from, next) => {
  const authStore = useAuthStore()

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    next({ name: RouteNames.Login, query: { redirect: to.fullPath } })
  } else {
    next()
  }
})

export default router
```

Note: Changed view imports from `'../views/X.vue'` to `'@/views/X.vue'` for consistency and used `@/stores/auth` (already extensionless).

**Step 2: Update router test import**

In `frontend/src/router/__tests__/index.test.ts`, line 24:
```ts
// Before:
import router from '@/router/index.js'
// After:
import router from '@/router'
```

**Step 3: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 4: Commit**

```bash
git add frontend/src/router/index.ts frontend/src/router/__tests__/index.test.ts
git commit -m "refactor(frontend): migrate router to TypeScript with route name constants (#37)"
```

---

### Task 7: Migrate main.js and vite.config.js to TypeScript

**Files:**
- Rename: `frontend/src/main.js` -> `frontend/src/main.ts`
- Modify: `frontend/index.html` (line 13: update script src)
- Rename: `frontend/vite.config.js` -> `frontend/vite.config.ts`

**Step 1: Rename main.js to main.ts**

Rename `frontend/src/main.js` to `frontend/src/main.ts`. Content unchanged:

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './assets/styles/globals.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
```

**Step 2: Update index.html**

In `frontend/index.html`, line 13:
```html
<!-- Before: -->
<script type="module" src="/src/main.js"></script>
<!-- After: -->
<script type="module" src="/src/main.ts"></script>
```

**Step 3: Rename vite.config.js to vite.config.ts**

Rename `frontend/vite.config.js` to `frontend/vite.config.ts`. Content unchanged.

**Step 4: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 5: Commit**

```bash
git add frontend/src/main.ts frontend/index.html frontend/vite.config.ts
git commit -m "refactor(frontend): migrate main.js and vite.config.js to TypeScript (#37)"
```

---

### Task 8: Update test-utils with types

**Files:**
- Modify: `frontend/src/test-utils.ts`

**Step 1: Add type imports and annotations**

Update `frontend/src/test-utils.ts`:

```ts
import { mount, type MountingOptions } from '@vue/test-utils'
import { createTestingPinia, type TestingOptions } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import { vi } from 'vitest'
import type { Component } from 'vue'
import type { UserInfo, Subscription, SubscriptionList, SearchResult } from '@/types/api'
import { RouteNames } from '@/router'

// ---- Mock data factories ----

export function mockUserInfo(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    student_id: '20210001',
    calendar_token: 'test-token-abc123',
    oauth_expires_at: '2026-03-02T12:00:00Z',
    last_synced_at: '2026-03-01T10:00:00Z',
    ...overrides,
  }
}

export function mockSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    calendar_token: 'sub-token-123',
    source_type: 'personal_all',
    source_id: '20210001',
    source_name: '张三',
    is_personal: true,
    session_name: '2025秋',
    last_synced_at: '2026-03-01T10:00:00Z',
    subscription_url: 'https://schedule.cqu.moe/api/v1/subscriptions/sub-token-123/calendar.ics',
    ...overrides,
  }
}

export function mockSubscriptionList(subs: Subscription[] = [mockSubscription()], max = 5): SubscriptionList {
  return { subscriptions: subs, max }
}

export function mockSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'result-1',
    name: '高等数学',
    extra: '数学学院',
    ...overrides,
  }
}

// ---- Mock API ----

export function createMockApi() {
  return {
    register: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getCaptchaConfig: vi.fn().mockResolvedValue({ enabled: false, sitekey: '' }),
    getUserInfo: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn().mockResolvedValue(mockSubscriptionList([])),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
    getConfig: vi.fn().mockResolvedValue({ public_url: 'https://schedule.cqu.moe' }),
  }
}

// ---- Router for tests ----

const routes = [
  { path: '/', name: RouteNames.Home, component: { template: '<div>Home</div>' } },
  { path: '/login', name: RouteNames.Login, component: { template: '<div>Login</div>' } },
  { path: '/register', name: RouteNames.Register, component: { template: '<div>Register</div>' } },
  { path: '/recover', name: RouteNames.Recover, component: { template: '<div>Recover</div>' } },
  { path: '/dashboard', name: RouteNames.Dashboard, component: { template: '<div>Dashboard</div>' }, meta: { requiresAuth: true } },
  { path: '/add', name: RouteNames.Add, component: { template: '<div>Add</div>' } },
  { path: '/api-docs', name: RouteNames.ApiDocs, component: { template: '<div>Docs</div>' } },
]

export function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  })
}

// ---- Mount helper ----

interface TestMountOptions extends MountingOptions<any> {
  pinia?: TestingOptions
  initialRoute?: string
}

export async function mountWithContext(
  component: Component,
  options: TestMountOptions = {},
) {
  const { pinia: piniaOpts, initialRoute, ...mountOpts } = options

  const router = createTestRouter()
  if (initialRoute) {
    router.push(initialRoute)
    await router.isReady()
  }

  const pinia = createTestingPinia({
    createSpy: vi.fn,
    stubActions: false,
    ...piniaOpts,
  })

  const { stubs: customStubs, ...restGlobal } = mountOpts.global || {}

  const wrapper = mount(component, {
    ...mountOpts,
    global: {
      plugins: [pinia, router],
      ...restGlobal,
      stubs: {
        Navbar: { template: '<nav data-testid="navbar" />' },
        RiskWarning: { template: '<div data-testid="risk-warning" />' },
        QrcodeModal: { template: '<div data-testid="qrcode-modal" />' },
        ...(customStubs as Record<string, any> || {}),
      },
    },
  })

  await router.isReady()
  return { wrapper, router, pinia }
}
```

Key changes:
- Import types from `@/types/api`
- Import `RouteNames` from `@/router`
- Add `Partial<T>` parameter types and return types to mock factories
- Use `RouteNames` constants in test routes

**Step 2: Verify**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 3: Commit**

```bash
git add frontend/src/test-utils.ts
git commit -m "refactor(frontend): add types to test-utils (#37)"
```

---

### Task 9: Final verification and cleanup

**Step 1: Verify no .js core files remain**

Run: `ls frontend/src/main.* frontend/src/api/index.* frontend/src/router/index.* frontend/src/stores/*.* frontend/vite.config.*`

Expected: Only `.ts` files (no `.js` files for the migrated modules). Note `stores/` may still contain `__tests__/` subdirectory which is fine.

**Step 2: Verify no stale .js import references**

Run: `grep -r '\.js['\''"]' frontend/src/ --include='*.ts' --include='*.vue' --include='*.js' | grep -v node_modules | grep -v __tests__`

Expected: No matches (all `.js` extension imports have been cleaned up)

**Step 3: Full verification**

Run: `cd frontend && npm run build && npm test`
Expected: Build passes, all tests pass

**Step 4: Verify old .js files are gone from git**

Run: `git status`
Expected: Shows renamed files (old `.js` deleted, new `.ts` added)
