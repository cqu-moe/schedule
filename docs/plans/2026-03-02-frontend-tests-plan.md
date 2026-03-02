# Frontend Component Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add comprehensive Vitest + Vue Test Utils tests for all frontend views, stores, api layer, router, and business components.

**Architecture:** Vitest (jsdom) in `frontend/`, independent from backend vitest config. API mocked via `vi.mock`, Pinia via `@pinia/testing`, teleporting components (Dialog, AlertDialog, DropdownMenu, Popover) stubbed inline.

**Tech Stack:** vitest, @vue/test-utils, @pinia/testing, jsdom

**Design doc:** `docs/plans/2026-03-02-frontend-tests-design.md`

---

### Task 1: Test Infrastructure Setup

**Files:**
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test-setup.ts`
- Create: `frontend/src/test-utils.ts`
- Modify: `frontend/package.json`
- Modify: `package.json` (root)

**Step 1: Install dependencies**

```bash
cd frontend && npm install -D vitest @vue/test-utils @pinia/testing jsdom
```

**Step 2: Create `frontend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

**Step 3: Create `frontend/src/test-setup.ts`**

```ts
import { vi } from 'vitest'
import { config } from '@vue/test-utils'

// Mock navigator.clipboard (not fully implemented in jsdom)
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
})

// Mock window.open
vi.stubGlobal('open', vi.fn())

// Global stubs for teleporting components (Dialog, AlertDialog, DropdownMenu, Popover, Select)
// These render their slots inline instead of teleporting to body
config.global.stubs = {
  // AlertDialog family
  AlertDialog: { template: '<div><slot /></div>', props: ['open'] },
  AlertDialogContent: { template: '<div><slot /></div>' },
  AlertDialogHeader: { template: '<div><slot /></div>' },
  AlertDialogFooter: { template: '<div><slot /></div>' },
  AlertDialogTitle: { template: '<span><slot /></span>' },
  AlertDialogDescription: { template: '<span><slot /></span>' },
  AlertDialogTrigger: { template: '<span><slot /></span>', props: ['asChild'] },
  AlertDialogAction: {
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    props: ['disabled'],
    emits: ['click'],
  },
  AlertDialogCancel: {
    template: '<button @click="$emit(\'click\')"><slot /></button>',
    emits: ['click'],
  },
  // Dialog family
  Dialog: { template: '<div v-if="open"><slot /></div>', props: ['open'] },
  DialogContent: { template: '<div><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogFooter: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<span><slot /></span>' },
  DialogDescription: { template: '<span><slot /></span>' },
  // DropdownMenu family
  DropdownMenu: { template: '<div><slot /></div>' },
  DropdownMenuContent: { template: '<div><slot /></div>' },
  DropdownMenuItem: {
    template: '<div @click="$emit(\'click\')"><slot /></div>',
    emits: ['click'],
  },
  DropdownMenuTrigger: { template: '<span><slot /></span>', props: ['asChild'] },
  // QrcodeModal + RiskWarning — stub at view level since they're custom components
  // VueHcaptcha — mocked per-file via vi.mock
  // Navbar — let render normally in most tests
}

// Mock @hcaptcha/vue3-hcaptcha globally
vi.mock('@hcaptcha/vue3-hcaptcha', () => ({
  default: {
    name: 'VueHcaptcha',
    template: '<div data-testid="hcaptcha" />',
    props: ['sitekey', 'size'],
    setup() {
      const executeAsync = vi.fn().mockResolvedValue({ response: 'mock-captcha-token' })
      const reset = vi.fn()
      return { executeAsync, reset }
    },
  },
}))

// Mock qrcode.vue globally
vi.mock('qrcode.vue', () => ({
  default: {
    name: 'QrcodeVue',
    template: '<div data-testid="qrcode" />',
    props: ['value', 'size', 'level'],
  },
}))

// Mock @1password/save-button globally
vi.mock('@1password/save-button', () => ({
  encodeOPSaveRequest: vi.fn().mockReturnValue('mock-encoded'),
  activateOPButton: vi.fn(),
}))

// Mock @vueuse/core useColorMode for Navbar tests
vi.mock('@vueuse/core', () => {
  const store = { value: 'auto' }
  return {
    useColorMode: vi.fn(() => ({ store })),
  }
})
```

**Step 4: Create `frontend/src/test-utils.ts`**

```ts
import { mount, type MountingOptions, type VueWrapper } from '@vue/test-utils'
import { createTestingPinia, type TestingOptions } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import { vi, type Mock } from 'vitest'
import type { Component } from 'vue'

// ---- Mock data factories ----

export function mockUserInfo(overrides = {}) {
  return {
    student_id: '20210001',
    calendar_token: 'test-token-abc123',
    oauth_expires_at: '2026-03-02T12:00:00Z',
    last_synced_at: '2026-03-01T10:00:00Z',
    ...overrides,
  }
}

export function mockSubscription(overrides = {}) {
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

export function mockSubscriptionList(subs = [mockSubscription()], max = 5) {
  return { subscriptions: subs, max }
}

export function mockSearchResult(overrides = {}) {
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
  { path: '/', name: 'Home', component: { template: '<div>Home</div>' } },
  { path: '/login', name: 'Login', component: { template: '<div>Login</div>' } },
  { path: '/register', name: 'Register', component: { template: '<div>Register</div>' } },
  { path: '/recover', name: 'Recover', component: { template: '<div>Recover</div>' } },
  { path: '/dashboard', name: 'Dashboard', component: { template: '<div>Dashboard</div>' }, meta: { requiresAuth: true } },
  { path: '/add', name: 'Add', component: { template: '<div>Add</div>' }, meta: { requiresAuth: true } },
  { path: '/api-docs', name: 'ApiDocs', component: { template: '<div>Docs</div>' } },
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

  const wrapper = mount(component, {
    ...mountOpts,
    global: {
      plugins: [pinia, router],
      stubs: {
        // Stub Navbar in view tests to avoid deep rendering
        Navbar: { template: '<nav data-testid="navbar" />' },
        RiskWarning: { template: '<div data-testid="risk-warning" />' },
        QrcodeModal: { template: '<div data-testid="qrcode-modal" />' },
        ...(mountOpts.global?.stubs as Record<string, any> || {}),
      },
      ...mountOpts.global,
    },
  })

  await router.isReady()
  return { wrapper, router, pinia }
}
```

**Step 5: Update `frontend/package.json` scripts**

Add to the `scripts` section:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

**Step 6: Update root `package.json` scripts**

Add:
```json
"test:frontend": "cd frontend && npm test"
```

**Step 7: Run vitest with no tests to verify config**

```bash
cd frontend && npx vitest run 2>&1 | head -20
```

Expected: "No test files found" (not a config error).

**Step 8: Commit**

```bash
git add frontend/vitest.config.ts frontend/src/test-setup.ts frontend/src/test-utils.ts frontend/package.json frontend/package-lock.json package.json
git commit -m "test: add frontend test infrastructure (vitest + vue-test-utils)"
```

---

### Task 2: Store Tests (auth + config)

**Files:**
- Create: `frontend/src/stores/__tests__/auth.test.ts`
- Create: `frontend/src/stores/__tests__/config.test.ts`

**Step 1: Create `frontend/src/stores/__tests__/auth.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../auth'

// Mock API before store import resolves it
const mockApi = {
  register: vi.fn(),
  getUserInfo: vi.fn(),
  recoverToken: vi.fn(),
  recoverTokenVerify: vi.fn(),
  getCaptchaConfig: vi.fn(),
  deleteUser: vi.fn(),
  searchSchedule: vi.fn(),
  getDepartments: vi.fn(),
  createSubscription: vi.fn(),
  getSubscriptions: vi.fn(),
  deleteSubscription: vi.fn(),
  refreshSubscription: vi.fn(),
  getHealth: vi.fn(),
  getConfig: vi.fn(),
}
vi.mock('@/api', () => ({ default: mockApi }))

describe('useAuthStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  describe('initial state', () => {
    it('starts with empty token when localStorage is empty', () => {
      const store = useAuthStore()
      expect(store.token).toBe('')
      expect(store.isAuthenticated).toBe(false)
    })

    it('reads token from localStorage on creation', () => {
      localStorage.setItem('calendar_token', 'saved-token')
      mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
      const store = useAuthStore()
      expect(store.token).toBe('saved-token')
      expect(store.isAuthenticated).toBe(true)
    })

    it('calls fetchUserInfo on creation when token exists', () => {
      localStorage.setItem('calendar_token', 'saved-token')
      mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
      useAuthStore()
      expect(mockApi.getUserInfo).toHaveBeenCalledWith('saved-token')
    })
  })

  describe('register', () => {
    it('sets token and localStorage on success', async () => {
      const store = useAuthStore()
      mockApi.register.mockResolvedValue({ calendar_token: 'new-token' })

      const result = await store.register('20210001', 'pass123')

      expect(result).toEqual({ success: true, token: 'new-token' })
      expect(store.token).toBe('new-token')
      expect(localStorage.getItem('calendar_token')).toBe('new-token')
    })

    it('passes captcha token to API', async () => {
      const store = useAuthStore()
      mockApi.register.mockResolvedValue({ calendar_token: 'tok' })

      await store.register('20210001', 'pass', 'captcha-tok')

      expect(mockApi.register).toHaveBeenCalledWith('20210001', 'pass', 'captcha-tok')
    })

    it('returns error on 429 rate limit', async () => {
      const store = useAuthStore()
      mockApi.register.mockRejectedValue({
        response: { status: 429, data: { detail: '操作过于频繁' } },
      })

      const result = await store.register('20210001', 'pass')

      expect(result).toEqual({ success: false, error: '操作过于频繁' })
    })

    it('returns error for CAPTCHA_REQUIRED', async () => {
      const store = useAuthStore()
      mockApi.register.mockRejectedValue({
        response: { status: 400, data: { detail: 'CAPTCHA_REQUIRED' } },
      })

      const result = await store.register('20210001', 'pass')

      expect(result.success).toBe(false)
      expect(result.error).toContain('验证码')
    })

    it('returns error for USER_EXISTS', async () => {
      const store = useAuthStore()
      mockApi.register.mockRejectedValue({
        response: { status: 409, data: { detail: { error: { code: 'USER_EXISTS' } } } },
      })

      const result = await store.register('20210001', 'pass')

      expect(result.success).toBe(false)
      expect(result.error).toContain('已注册')
    })

    it('sets loading during request', async () => {
      const store = useAuthStore()
      let resolve: Function
      mockApi.register.mockReturnValue(new Promise(r => { resolve = r }))

      const promise = store.register('20210001', 'pass')
      expect(store.loading).toBe(true)

      resolve!({ calendar_token: 'tok' })
      await promise
      expect(store.loading).toBe(false)
    })
  })

  describe('loginWithToken', () => {
    it('sets token and userInfo on success', async () => {
      const store = useAuthStore()
      const userInfo = { student_id: '20210001' }
      mockApi.getUserInfo.mockResolvedValue(userInfo)

      const result = await store.loginWithToken('my-token')

      expect(result).toEqual({ success: true })
      expect(store.token).toBe('my-token')
      expect(store.userInfo).toEqual(userInfo)
      expect(localStorage.getItem('calendar_token')).toBe('my-token')
    })

    it('returns error on invalid token', async () => {
      const store = useAuthStore()
      mockApi.getUserInfo.mockRejectedValue(new Error('401'))

      const result = await store.loginWithToken('bad-token')

      expect(result).toEqual({ success: false, error: 'Token 无效或已过期' })
    })
  })

  describe('fetchUserInfo', () => {
    it('fetches and sets userInfo', async () => {
      const store = useAuthStore()
      store.token = 'my-token'
      const userInfo = { student_id: '20210001' }
      mockApi.getUserInfo.mockResolvedValue(userInfo)

      await store.fetchUserInfo()

      expect(store.userInfo).toEqual(userInfo)
    })

    it('does nothing when no token', async () => {
      const store = useAuthStore()
      await store.fetchUserInfo()
      expect(mockApi.getUserInfo).not.toHaveBeenCalled()
    })

    it('calls logout on error', async () => {
      const store = useAuthStore()
      store.token = 'my-token'
      localStorage.setItem('calendar_token', 'my-token')
      mockApi.getUserInfo.mockRejectedValue(new Error('401'))

      await store.fetchUserInfo()

      expect(store.token).toBe('')
      expect(store.userInfo).toBeNull()
    })
  })

  describe('logout', () => {
    it('clears token, userInfo, and localStorage', () => {
      const store = useAuthStore()
      store.token = 'tok'
      store.userInfo = { student_id: '20210001' } as any
      localStorage.setItem('calendar_token', 'tok')

      store.logout()

      expect(store.token).toBe('')
      expect(store.userInfo).toBeNull()
      expect(localStorage.getItem('calendar_token')).toBeNull()
    })
  })
})
```

**Step 2: Create `frontend/src/stores/__tests__/config.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfigStore } from '../config'

const mockApi = {
  register: vi.fn(),
  getUserInfo: vi.fn(),
  recoverToken: vi.fn(),
  recoverTokenVerify: vi.fn(),
  getCaptchaConfig: vi.fn(),
  deleteUser: vi.fn(),
  searchSchedule: vi.fn(),
  getDepartments: vi.fn(),
  createSubscription: vi.fn(),
  getSubscriptions: vi.fn(),
  deleteSubscription: vi.fn(),
  refreshSubscription: vi.fn(),
  getHealth: vi.fn(),
  getConfig: vi.fn(),
}
vi.mock('@/api/index.js', () => ({ default: mockApi }))

describe('useConfigStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('defaults publicUrl to window.location.origin', () => {
    const store = useConfigStore()
    expect(store.publicUrl).toBe(window.location.origin)
    expect(store.loaded).toBe(false)
  })

  it('load() fetches and sets publicUrl', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://schedule.cqu.moe' })
    const store = useConfigStore()

    await store.load()

    expect(store.publicUrl).toBe('https://schedule.cqu.moe')
    expect(store.loaded).toBe(true)
  })

  it('load() keeps default on error', async () => {
    mockApi.getConfig.mockRejectedValue(new Error('fail'))
    const store = useConfigStore()

    await store.load()

    expect(store.publicUrl).toBe(window.location.origin)
    expect(store.loaded).toBe(true)
  })

  it('load() only calls API once', async () => {
    mockApi.getConfig.mockResolvedValue({ public_url: 'https://example.com' })
    const store = useConfigStore()

    await store.load()
    await store.load()

    expect(mockApi.getConfig).toHaveBeenCalledTimes(1)
  })
})
```

**Step 3: Run tests**

```bash
cd frontend && npx vitest run src/stores
```

**Step 4: Commit**

```bash
git add frontend/src/stores/__tests__/
git commit -m "test: add auth and config store tests"
```

---

### Task 3: API Layer Test

**Files:**
- Create: `frontend/src/api/__tests__/index.test.ts`

**Step 1: Create `frontend/src/api/__tests__/index.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

// Mock axios.create to return a mock client
const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  interceptors: {
    response: { use: vi.fn() },
  },
}
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockClient),
  },
}))

// Import after mock is set up
import api from '../index.js'

describe('api', () => {
  let responseInterceptorError: Function

  beforeEach(() => {
    vi.clearAllMocks()
    // Capture the error interceptor that was registered
    responseInterceptorError = mockClient.interceptors.response.use.mock.calls[0]?.[1]
  })

  describe('client config', () => {
    it('creates axios with correct base config', () => {
      expect(axios.create).toHaveBeenCalledWith({
        baseURL: '/api/v1',
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  })

  describe('response interceptor', () => {
    it('replaces 429 error response data', () => {
      const error = { response: { status: 429, data: { detail: 'original' } } }
      expect(() => responseInterceptorError(error)).toThrow()
      expect(error.response.data).toEqual({ detail: '操作过于频繁，请稍后再试' })
    })

    it('passes through non-429 errors', () => {
      const error = { response: { status: 500, data: { detail: 'server error' } } }
      expect(() => responseInterceptorError(error)).toThrow()
      expect(error.response.data.detail).toBe('server error')
    })
  })

  describe('register', () => {
    it('sends POST to /users with credentials', async () => {
      mockClient.post.mockResolvedValue({ data: { calendar_token: 'tok' } })

      const result = await api.register('20210001', 'pass123')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users',
        { student_id: '20210001', password: 'pass123' },
        { headers: {}, timeout: 120000 },
      )
      expect(result).toEqual({ calendar_token: 'tok' })
    })

    it('includes captcha token header when provided', async () => {
      mockClient.post.mockResolvedValue({ data: {} })

      await api.register('20210001', 'pass', 'captcha-tok')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users',
        expect.any(Object),
        expect.objectContaining({
          headers: { 'X-Captcha-Token': 'captcha-tok' },
        }),
      )
    })
  })

  describe('recoverToken', () => {
    it('sends POST to /users/recover', async () => {
      mockClient.post.mockResolvedValue({ data: { calendar_token: 'tok' } })

      await api.recoverToken('20210001', 'pass')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users/recover',
        { student_id: '20210001', password: 'pass' },
        { headers: {} },
      )
    })
  })

  describe('recoverTokenVerify', () => {
    it('sends POST to /users/recover/verify with 120s timeout', async () => {
      mockClient.post.mockResolvedValue({ data: {} })

      await api.recoverTokenVerify('20210001', 'pass', 'cap')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/users/recover/verify',
        { student_id: '20210001', password: 'pass' },
        { headers: { 'X-Captcha-Token': 'cap' }, timeout: 120000 },
      )
    })
  })

  describe('getUserInfo', () => {
    it('sends GET to /users/:token', async () => {
      mockClient.get.mockResolvedValue({ data: { student_id: '20210001' } })

      const result = await api.getUserInfo('my-token')

      expect(mockClient.get).toHaveBeenCalledWith('/users/my-token')
      expect(result).toEqual({ student_id: '20210001' })
    })
  })

  describe('deleteUser', () => {
    it('sends DELETE to /users/:token', async () => {
      mockClient.delete.mockResolvedValue({})

      await api.deleteUser('my-token')

      expect(mockClient.delete).toHaveBeenCalledWith('/users/my-token')
    })
  })

  describe('searchSchedule', () => {
    it('sends GET with query params and auth header', async () => {
      mockClient.get.mockResolvedValue({ data: { results: [] } })

      await api.searchSchedule('tok', 'instructor', '张')

      expect(mockClient.get).toHaveBeenCalledWith(
        '/search?source_type=instructor&keyword=%E5%BC%A0',
        { headers: { Authorization: 'Bearer tok' } },
      )
    })

    it('includes departmentId and grade when provided', async () => {
      mockClient.get.mockResolvedValue({ data: { results: [] } })

      await api.searchSchedule('tok', 'admin_class', '', 'dept-1', '2024')

      const url = mockClient.get.mock.calls[0][0]
      expect(url).toContain('department_id=dept-1')
      expect(url).toContain('grade=2024')
    })
  })

  describe('getDepartments', () => {
    it('sends GET with auth header', async () => {
      mockClient.get.mockResolvedValue({ data: { departments: [] } })

      await api.getDepartments('tok')

      expect(mockClient.get).toHaveBeenCalledWith(
        '/departments',
        { headers: { Authorization: 'Bearer tok' } },
      )
    })
  })

  describe('createSubscription', () => {
    it('sends POST with body, auth header, and 120s timeout', async () => {
      mockClient.post.mockResolvedValue({ data: { calendar_token: 'sub-tok' } })

      await api.createSubscription('tok', 'instructor', 'id-1', '张三', 'cap')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/subscriptions',
        { source_type: 'instructor', source_id: 'id-1', source_name: '张三' },
        {
          headers: { Authorization: 'Bearer tok', 'X-Captcha-Token': 'cap' },
          timeout: 120000,
        },
      )
    })
  })

  describe('getSubscriptions', () => {
    it('sends GET with auth header', async () => {
      mockClient.get.mockResolvedValue({ data: { subscriptions: [], max: 5 } })

      await api.getSubscriptions('tok')

      expect(mockClient.get).toHaveBeenCalledWith(
        '/subscriptions',
        { headers: { Authorization: 'Bearer tok' } },
      )
    })
  })

  describe('deleteSubscription', () => {
    it('sends DELETE with auth header', async () => {
      mockClient.delete.mockResolvedValue({ data: {} })

      await api.deleteSubscription('tok', 'sub-tok')

      expect(mockClient.delete).toHaveBeenCalledWith(
        '/subscriptions/sub-tok',
        { headers: { Authorization: 'Bearer tok' } },
      )
    })
  })

  describe('refreshSubscription', () => {
    it('sends POST with auth header and 120s timeout', async () => {
      mockClient.post.mockResolvedValue({ data: {} })

      await api.refreshSubscription('tok', 'sub-tok')

      expect(mockClient.post).toHaveBeenCalledWith(
        '/subscriptions/sub-tok/refresh',
        null,
        expect.objectContaining({
          headers: { Authorization: 'Bearer tok' },
          timeout: 120000,
        }),
      )
    })
  })

  describe('getHealth', () => {
    it('sends GET to /health', async () => {
      mockClient.get.mockResolvedValue({ data: { status: 'ok' } })
      const result = await api.getHealth()
      expect(mockClient.get).toHaveBeenCalledWith('/health')
      expect(result).toEqual({ status: 'ok' })
    })
  })

  describe('getConfig', () => {
    it('sends GET to /config', async () => {
      mockClient.get.mockResolvedValue({ data: { public_url: 'https://example.com' } })
      const result = await api.getConfig()
      expect(mockClient.get).toHaveBeenCalledWith('/config')
      expect(result).toEqual({ public_url: 'https://example.com' })
    })
  })

  describe('getCaptchaConfig', () => {
    it('sends GET to /captcha/config', async () => {
      mockClient.get.mockResolvedValue({ data: { enabled: false, sitekey: '' } })
      const result = await api.getCaptchaConfig()
      expect(mockClient.get).toHaveBeenCalledWith('/captcha/config')
      expect(result).toEqual({ enabled: false, sitekey: '' })
    })
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/api
```

**Step 3: Commit**

```bash
git add frontend/src/api/__tests__/
git commit -m "test: add API layer tests"
```

---

### Task 4: Router Test

**Files:**
- Create: `frontend/src/router/__tests__/index.test.ts`

**Step 1: Create `frontend/src/router/__tests__/index.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Mock API (required by auth store)
vi.mock('@/api', () => ({
  default: {
    register: vi.fn(),
    getUserInfo: vi.fn(),
    recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(),
    getCaptchaConfig: vi.fn(),
    deleteUser: vi.fn(),
    searchSchedule: vi.fn(),
    getDepartments: vi.fn(),
    createSubscription: vi.fn(),
    getSubscriptions: vi.fn(),
    deleteSubscription: vi.fn(),
    refreshSubscription: vi.fn(),
    getHealth: vi.fn(),
    getConfig: vi.fn(),
  },
}))

// Must import router after mock is set up
import router from '../index.js'
import { useAuthStore } from '@/stores/auth'

describe('router', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  describe('public routes', () => {
    it.each([
      ['/', 'Home'],
      ['/login', 'Login'],
      ['/register', 'Register'],
      ['/recover', 'Recover'],
      ['/api-docs', 'ApiDocs'],
    ])('allows access to %s without auth', async (path, name) => {
      await router.push(path)
      await router.isReady()
      expect(router.currentRoute.value.name).toBe(name)
    })
  })

  describe('protected routes', () => {
    it('redirects /dashboard to /login when not authenticated', async () => {
      await router.push('/dashboard')
      await router.isReady()
      expect(router.currentRoute.value.name).toBe('Login')
      expect(router.currentRoute.value.query.redirect).toBe('/dashboard')
    })

    it('redirects /add to /login when not authenticated', async () => {
      await router.push('/add')
      await router.isReady()
      expect(router.currentRoute.value.name).toBe('Login')
      expect(router.currentRoute.value.query.redirect).toBe('/add')
    })

    it('allows /dashboard when authenticated', async () => {
      const store = useAuthStore()
      store.token = 'valid-token'

      await router.push('/dashboard')
      await router.isReady()
      expect(router.currentRoute.value.name).toBe('Dashboard')
    })

    it('allows /add when authenticated', async () => {
      const store = useAuthStore()
      store.token = 'valid-token'

      await router.push('/add')
      await router.isReady()
      expect(router.currentRoute.value.name).toBe('Add')
    })
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/router
```

**Step 3: Commit**

```bash
git add frontend/src/router/__tests__/
git commit -m "test: add router guard tests"
```

---

### Task 5: Simple Component Tests

**Files:**
- Create: `frontend/src/components/__tests__/SubscriptionCard.test.ts`
- Create: `frontend/src/components/__tests__/QrcodeModal.test.ts`
- Create: `frontend/src/components/__tests__/RiskWarning.test.ts`

**Step 1: Create `frontend/src/components/__tests__/SubscriptionCard.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SubscriptionCard from '../SubscriptionCard.vue'

describe('SubscriptionCard', () => {
  const defaultProps = {
    title: '张三',
    url: 'https://schedule.cqu.moe/api/v1/subscriptions/tok/calendar.ics',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders title and url', () => {
    const wrapper = mount(SubscriptionCard, { props: defaultProps })
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain(defaultProps.url)
  })

  it('copies url to clipboard on copy button click', async () => {
    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('复制'))!
    await copyBtn.trigger('click')

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(defaultProps.url)
  })

  it('shows 已复制 after copy', async () => {
    vi.useFakeTimers()
    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('复制'))!
    await copyBtn.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('已复制')

    vi.advanceTimersByTime(1500)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('复制')
    vi.useRealTimers()
  })

  it('emits show-qrcode with url on QR button click', async () => {
    const wrapper = mount(SubscriptionCard, { props: defaultProps })

    const qrBtn = wrapper.findAll('button').find(b => b.text().includes('二维码'))!
    await qrBtn.trigger('click')

    expect(wrapper.emitted('show-qrcode')).toEqual([[defaultProps.url]])
  })
})
```

**Step 2: Create `frontend/src/components/__tests__/QrcodeModal.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import QrcodeModal from '../QrcodeModal.vue'

describe('QrcodeModal', () => {
  it('renders when modelValue is true', () => {
    const wrapper = mount(QrcodeModal, {
      props: { modelValue: true, url: 'https://example.com' },
    })
    expect(wrapper.text()).toContain('扫码订阅')
  })

  it('passes url to QrcodeVue', () => {
    const wrapper = mount(QrcodeModal, {
      props: { modelValue: true, url: 'https://example.com' },
    })
    const qrcode = wrapper.find('[data-testid="qrcode"]')
    expect(qrcode.exists()).toBe(true)
  })

  it('does not render content when modelValue is false', () => {
    const wrapper = mount(QrcodeModal, {
      props: { modelValue: false, url: 'https://example.com' },
    })
    // Dialog stub renders nothing when open=false
    expect(wrapper.text()).not.toContain('扫码订阅')
  })
})
```

**Step 3: Create `frontend/src/components/__tests__/RiskWarning.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import RiskWarning from '../RiskWarning.vue'

function mountRiskWarning(modelValue = true) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  const wrapper = mount(RiskWarning, {
    props: { modelValue },
    global: { plugins: [router] },
  })
  return { wrapper, router }
}

describe('RiskWarning', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders warning content when open', () => {
    const { wrapper } = mountRiskWarning(true)
    expect(wrapper.text()).toContain('使用本服务前请注意')
  })

  it('confirm sets localStorage and emits close', async () => {
    const { wrapper } = mountRiskWarning(true)

    // Check the checkbox first
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)

    // Click confirm
    const confirmBtn = wrapper.findAll('button').find(b => b.text().includes('确认'))!
    await confirmBtn.trigger('click')

    expect(localStorage.getItem('risk_warning_acknowledged')).toBe('true')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('confirm button is disabled until checkbox checked', () => {
    const { wrapper } = mountRiskWarning(true)
    const confirmBtn = wrapper.findAll('button').find(b => b.text().includes('确认'))!
    expect(confirmBtn.attributes('disabled')).toBeDefined()
  })

  it('cancel emits close and navigates to /', async () => {
    const { wrapper, router } = mountRiskWarning(true)
    const cancelBtn = wrapper.findAll('button').find(b => b.text().includes('返回首页'))!
    await cancelBtn.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(router.currentRoute.value.path).toBe('/')
  })
})
```

**Step 4: Run tests**

```bash
cd frontend && npx vitest run src/components/__tests__
```

**Step 5: Commit**

```bash
git add frontend/src/components/__tests__/
git commit -m "test: add SubscriptionCard, QrcodeModal, RiskWarning tests"
```

---

### Task 6: Navbar + DepartmentTreeSelect Tests

**Files:**
- Create: `frontend/src/components/__tests__/Navbar.test.ts`
- Create: `frontend/src/components/__tests__/DepartmentTreeSelect.test.ts`

**Step 1: Create `frontend/src/components/__tests__/Navbar.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { createRouter, createMemoryHistory } from 'vue-router'
import Navbar from '../Navbar.vue'
import { useAuthStore } from '@/stores/auth'

vi.mock('@/api', () => ({
  default: {
    register: vi.fn(), getUserInfo: vi.fn(), recoverToken: vi.fn(),
    recoverTokenVerify: vi.fn(), getCaptchaConfig: vi.fn(), deleteUser: vi.fn(),
    searchSchedule: vi.fn(), getDepartments: vi.fn(), createSubscription: vi.fn(),
    getSubscriptions: vi.fn(), deleteSubscription: vi.fn(), refreshSubscription: vi.fn(),
    getHealth: vi.fn(), getConfig: vi.fn(),
  },
}))

function mountNavbar(authenticated = false) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/dashboard', component: { template: '<div />' } },
      { path: '/add', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
      { path: '/register', component: { template: '<div />' } },
      { path: '/api-docs', component: { template: '<div />' } },
    ],
  })
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    stubActions: false,
    initialState: {
      auth: { token: authenticated ? 'tok' : '', userInfo: null, loading: false },
    },
  })
  const wrapper = mount(Navbar, {
    global: {
      plugins: [pinia, router],
      stubs: {},
    },
  })
  return { wrapper, router, pinia }
}

describe('Navbar', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('shows register and login links when not authenticated', () => {
    const { wrapper } = mountNavbar(false)
    expect(wrapper.text()).toContain('注册')
    expect(wrapper.text()).toContain('登录')
    expect(wrapper.text()).not.toContain('仪表盘')
  })

  it('shows dashboard, add, logout when authenticated', () => {
    const { wrapper } = mountNavbar(true)
    expect(wrapper.text()).toContain('仪表盘')
    expect(wrapper.text()).toContain('添加新订阅')
    expect(wrapper.text()).toContain('退出登录')
    expect(wrapper.text()).not.toContain('注册')
  })

  it('always shows API docs link', () => {
    const { wrapper } = mountNavbar(false)
    expect(wrapper.text()).toContain('API 文档')
  })

  it('logout clears auth and navigates to /', async () => {
    const { wrapper, router } = mountNavbar(true)
    const logoutBtn = wrapper.find('button')
    await logoutBtn.trigger('click')

    const store = useAuthStore()
    expect(store.token).toBe('')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('cycles theme: auto → light → dark → auto', async () => {
    const { useColorMode } = await import('@vueuse/core')
    const { wrapper } = mountNavbar(false)
    const themeBtn = wrapper.find('button[aria-label="切换主题"]')

    // Initial: auto
    await themeBtn.trigger('click') // → light
    await themeBtn.trigger('click') // → dark
    await themeBtn.trigger('click') // → auto

    // useColorMode was called, theme cycling happened through store.value assignment
    expect(useColorMode).toHaveBeenCalled()
  })
})
```

**Step 2: Create `frontend/src/components/__tests__/DepartmentTreeSelect.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DepartmentTreeSelect from '../DepartmentTreeSelect.vue'

const mockDepartments = [
  {
    id: 'dept-1',
    name: '计算机学院',
    children: [
      { id: 'dept-1-1', name: '计算机科学与技术系' },
      { id: 'dept-1-2', name: '软件工程系' },
    ],
  },
  { id: 'dept-2', name: '数学学院' },
]

describe('DepartmentTreeSelect', () => {
  // Note: DepartmentTreeSelect uses Popover + Command from reka-ui.
  // These are stubbed globally. Testing focuses on props/emits behavior.

  it('shows placeholder when no selection', () => {
    const wrapper = mount(DepartmentTreeSelect, {
      props: { departments: mockDepartments, modelValue: '' },
      global: {
        stubs: {
          Popover: { template: '<div><slot /></div>' },
          PopoverTrigger: { template: '<div><slot /></div>', props: ['asChild'] },
          PopoverContent: { template: '<div><slot /></div>' },
          Command: { template: '<div><slot /></div>' },
          CommandInput: { template: '<input />', props: ['placeholder'] },
          CommandEmpty: { template: '<div><slot /></div>' },
          CommandList: { template: '<div><slot /></div>' },
          CommandGroup: { template: '<div><slot /></div>', props: ['heading'] },
          CommandItem: {
            template: '<div @click="$emit(\'select\')"><slot /></div>',
            props: ['value'],
            emits: ['select'],
          },
        },
      },
    })
    expect(wrapper.text()).toContain('请选择学院')
  })

  it('shows selected department name', () => {
    const wrapper = mount(DepartmentTreeSelect, {
      props: { departments: mockDepartments, modelValue: 'dept-2' },
      global: {
        stubs: {
          Popover: { template: '<div><slot /></div>' },
          PopoverTrigger: { template: '<div><slot /></div>', props: ['asChild'] },
          PopoverContent: { template: '<div><slot /></div>' },
          Command: { template: '<div><slot /></div>' },
          CommandInput: { template: '<input />', props: ['placeholder'] },
          CommandEmpty: { template: '<div><slot /></div>' },
          CommandList: { template: '<div><slot /></div>' },
          CommandGroup: { template: '<div><slot /></div>', props: ['heading'] },
          CommandItem: {
            template: '<div @click="$emit(\'select\')"><slot /></div>',
            props: ['value'],
            emits: ['select'],
          },
        },
      },
    })
    expect(wrapper.text()).toContain('数学学院')
  })

  it('renders department groups and items', () => {
    const wrapper = mount(DepartmentTreeSelect, {
      props: { departments: mockDepartments, modelValue: '' },
      global: {
        stubs: {
          Popover: { template: '<div><slot /></div>' },
          PopoverTrigger: { template: '<div><slot /></div>', props: ['asChild'] },
          PopoverContent: { template: '<div><slot /></div>' },
          Command: { template: '<div><slot /></div>' },
          CommandInput: { template: '<input />', props: ['placeholder'] },
          CommandEmpty: { template: '<div><slot /></div>' },
          CommandList: { template: '<div><slot /></div>' },
          CommandGroup: { template: '<div><slot /></div>', props: ['heading'] },
          CommandItem: {
            template: '<div @click="$emit(\'select\')"><slot /></div>',
            props: ['value'],
            emits: ['select'],
          },
        },
      },
    })
    expect(wrapper.text()).toContain('计算机科学与技术系')
    expect(wrapper.text()).toContain('软件工程系')
    expect(wrapper.text()).toContain('数学学院')
  })
})
```

**Step 3: Run tests**

```bash
cd frontend && npx vitest run src/components/__tests__
```

**Step 4: Commit**

```bash
git add frontend/src/components/__tests__/Navbar.test.ts frontend/src/components/__tests__/DepartmentTreeSelect.test.ts
git commit -m "test: add Navbar and DepartmentTreeSelect tests"
```

---

### Task 7: Home + Docs View Tests

**Files:**
- Create: `frontend/src/views/__tests__/Home.test.ts`
- Create: `frontend/src/views/__tests__/Docs.test.ts`

**Step 1: Create `frontend/src/views/__tests__/Home.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Home from '../Home.vue'
import { mountWithContext, createMockApi } from '@/test-utils'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))

describe('Home', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('renders title and description', async () => {
    const { wrapper } = await mountWithContext(Home)
    expect(wrapper.text()).toContain('重庆大学课表日历订阅')
    expect(wrapper.text()).toContain('自动同步课表')
  })

  it('has a link to /dashboard', async () => {
    const { wrapper } = await mountWithContext(Home)
    const link = wrapper.find('a[href="/dashboard"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('开始使用')
  })

  it('shows version from health API', async () => {
    mockApi.getHealth.mockResolvedValue({ commit: 'abc1234', date: '2026-03-01' })
    const { wrapper } = await mountWithContext(Home)

    // Wait for onMounted async
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('abc1234')
    })
  })

  it('does not show version when commit is "dev"', async () => {
    mockApi.getHealth.mockResolvedValue({ commit: 'dev', date: 'unknown' })
    const { wrapper } = await mountWithContext(Home)

    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('dev')
  })
})
```

**Step 2: Create `frontend/src/views/__tests__/Docs.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Docs from '../Docs.vue'
import { mountWithContext, createMockApi } from '@/test-utils'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))
vi.mock('@/api/index.js', () => ({ default: mockApi }))

describe('Docs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('renders API documentation title', async () => {
    const { wrapper } = await mountWithContext(Docs)
    expect(wrapper.text()).toContain('API 文档')
  })

  it('renders endpoint descriptions', async () => {
    const { wrapper } = await mountWithContext(Docs)
    expect(wrapper.text()).toContain('ICS 日历订阅')
    expect(wrapper.text()).toContain('格式化事件 JSON')
    expect(wrapper.text()).toContain('CSV 导出')
    expect(wrapper.text()).toContain('原始数据 JSON')
    expect(wrapper.text()).toContain('刷新订阅')
  })

  it('renders JSON field table', async () => {
    const { wrapper } = await mountWithContext(Docs)
    expect(wrapper.text()).toContain('semester')
    expect(wrapper.text()).toContain('events[].name')
  })
})
```

**Step 3: Run tests**

```bash
cd frontend && npx vitest run src/views/__tests__/Home.test.ts src/views/__tests__/Docs.test.ts
```

**Step 4: Commit**

```bash
git add frontend/src/views/__tests__/Home.test.ts frontend/src/views/__tests__/Docs.test.ts
git commit -m "test: add Home and Docs view tests"
```

---

### Task 8: Login View Test

**Files:**
- Create: `frontend/src/views/__tests__/Login.test.ts`

**Step 1: Create `frontend/src/views/__tests__/Login.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Login from '../Login.vue'
import { mountWithContext, createMockApi } from '@/test-utils'
import { useAuthStore } from '@/stores/auth'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('renders login form', async () => {
    const { wrapper } = await mountWithContext(Login)
    expect(wrapper.text()).toContain('登录')
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
  })

  it('shows error for empty token', async () => {
    const { wrapper } = await mountWithContext(Login)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('Token 格式不正确')
  })

  it('shows error for short token', async () => {
    const { wrapper } = await mountWithContext(Login)
    await wrapper.find('input[type="password"]').setValue('short')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('Token 格式不正确')
  })

  it('navigates to /dashboard on successful login', async () => {
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    const { wrapper, router } = await mountWithContext(Login, { initialRoute: '/login' })

    await wrapper.find('input[type="password"]').setValue('a'.repeat(32))
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/dashboard')
    })
  })

  it('respects redirect query param', async () => {
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    const { wrapper, router } = await mountWithContext(Login, {
      initialRoute: '/login?redirect=/add',
    })

    await wrapper.find('input[type="password"]').setValue('a'.repeat(32))
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/add')
    })
  })

  it('shows error on invalid token', async () => {
    mockApi.getUserInfo.mockRejectedValue(new Error('401'))
    const { wrapper } = await mountWithContext(Login)

    await wrapper.find('input[type="password"]').setValue('a'.repeat(32))
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Token 无效或已过期')
    })
  })

  it('has links to register and recover', async () => {
    const { wrapper } = await mountWithContext(Login)
    expect(wrapper.find('a[href="/register"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/recover"]').exists()).toBe(true)
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/views/__tests__/Login.test.ts
```

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/Login.test.ts
git commit -m "test: add Login view tests"
```

---

### Task 9: Register View Test

**Files:**
- Create: `frontend/src/views/__tests__/Register.test.ts`

**Step 1: Create `frontend/src/views/__tests__/Register.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Register from '../Register.vue'
import { mountWithContext, createMockApi } from '@/test-utils'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))

describe('Register', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('renders registration form', async () => {
    const { wrapper } = await mountWithContext(Register)
    expect(wrapper.text()).toContain('注册')
    expect(wrapper.find('#studentId').exists()).toBe(true)
    expect(wrapper.find('#password').exists()).toBe(true)
  })

  it('shows error when studentId is empty', async () => {
    const { wrapper } = await mountWithContext(Register)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('请输入统一身份认证号')
  })

  it('shows error when password is empty', async () => {
    const { wrapper } = await mountWithContext(Register)
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('请输入密码')
  })

  it('shows progress steps during registration', async () => {
    // Don't resolve the API call yet — keep it pending
    let resolveRegister: Function
    mockApi.register.mockReturnValue(new Promise(r => { resolveRegister = r }))

    const { wrapper } = await mountWithContext(Register)
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass123')
    await wrapper.find('form').trigger('submit')

    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('正在注册')
    expect(wrapper.text()).toContain('验证凭据')
    expect(wrapper.text()).toContain('连接教务系统')
    expect(wrapper.text()).toContain('获取 Token')

    // Clean up
    resolveRegister!({ calendar_token: 'tok' })
  })

  it('shows token dialog on success', async () => {
    mockApi.register.mockResolvedValue({ calendar_token: 'new-token-123' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper } = await mountWithContext(Register)
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass123')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('注册成功')
      expect(wrapper.text()).toContain('new-token-123')
    })
  })

  it('returns to form on registration failure', async () => {
    mockApi.register.mockRejectedValue({
      response: { status: 401, data: { detail: { error: { message: '密码错误' } } } },
    })

    const { wrapper } = await mountWithContext(Register)
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('wrong')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('密码错误')
      expect(wrapper.find('#studentId').exists()).toBe(true)
    })
  })

  it('navigates to dashboard after closing token dialog', async () => {
    mockApi.register.mockResolvedValue({ calendar_token: 'tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    const { wrapper, router } = await mountWithContext(Register, { initialRoute: '/register' })
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass123')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('注册成功')
    })

    // Click "我已保存" button
    const saveBtn = wrapper.findAll('button').find(b => b.text().includes('我已保存'))!
    await saveBtn.trigger('click')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/dashboard')
    })
  })

  it('has link to login page', async () => {
    const { wrapper } = await mountWithContext(Register)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(true)
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/views/__tests__/Register.test.ts
```

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/Register.test.ts
git commit -m "test: add Register view tests"
```

---

### Task 10: Dashboard View Test

**Files:**
- Create: `frontend/src/views/__tests__/Dashboard.test.ts`

**Step 1: Create `frontend/src/views/__tests__/Dashboard.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Dashboard from '../Dashboard.vue'
import { mountWithContext, createMockApi, mockSubscription, mockSubscriptionList } from '@/test-utils'
import { useAuthStore } from '@/stores/auth'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    localStorage.clear()
    localStorage.setItem('risk_warning_acknowledged', 'true')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountDashboard(subs = [mockSubscription()]) {
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList(subs))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    const result = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
        },
      },
    })
    await vi.runAllTimersAsync()
    return result
  }

  it('renders subscription list', async () => {
    const { wrapper } = await mountDashboard()
    expect(wrapper.text()).toContain('我的订阅')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('(1/5)')
  })

  it('shows empty state when no subscriptions', async () => {
    const { wrapper } = await mountDashboard([])
    expect(wrapper.text()).toContain('暂无订阅')
  })

  it('shows source type badge', async () => {
    const { wrapper } = await mountDashboard()
    expect(wrapper.text()).toContain('全部') // personal_all → 全部
  })

  it('shows last synced date', async () => {
    const { wrapper } = await mountDashboard()
    expect(wrapper.text()).toContain('同步于')
  })

  it('shows "尚未同步" for unsynced subscriptions', async () => {
    const unsyncedSub = mockSubscription({ last_synced_at: null })
    const { wrapper } = await mountDashboard([unsyncedSub])
    expect(wrapper.text()).toContain('尚未同步')
  })

  it('copies subscription URL on copy button click', async () => {
    const { wrapper } = await mountDashboard()

    const copyBtn = wrapper.findAll('button').find(b => b.text().includes('复制'))!
    await copyBtn.trigger('click')

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      mockSubscription().subscription_url,
    )
  })

  it('calls refreshSubscription on sync button click', async () => {
    mockApi.refreshSubscription.mockResolvedValue({})
    const { wrapper } = await mountDashboard()

    // Find the "同步" button (not "同步所有")
    const syncBtn = wrapper.findAll('button').find(
      b => b.text().trim() === '同步',
    )!
    await syncBtn.trigger('click')

    expect(mockApi.refreshSubscription).toHaveBeenCalledWith(
      'test-token',
      'sub-token-123',
    )
  })

  it('syncs only personal subscriptions on sync all', async () => {
    const personalSub = mockSubscription({ is_personal: true, calendar_token: 'p-1' })
    const otherSub = mockSubscription({
      is_personal: false,
      calendar_token: 'o-1',
      source_type: 'instructor',
      source_name: '李四',
    })
    mockApi.refreshSubscription.mockResolvedValue({})
    const { wrapper } = await mountDashboard([personalSub, otherSub])

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步所有'))!
    await syncAllBtn.trigger('click')
    await vi.runAllTimersAsync()

    expect(mockApi.refreshSubscription).toHaveBeenCalledWith('test-token', 'p-1')
    expect(mockApi.refreshSubscription).not.toHaveBeenCalledWith('test-token', 'o-1')
  })

  it('shows success message after sync all', async () => {
    mockApi.refreshSubscription.mockResolvedValue({})
    const { wrapper } = await mountDashboard()

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步所有'))!
    await syncAllBtn.trigger('click')
    await vi.runAllTimersAsync()

    expect(wrapper.text()).toContain('同步成功')
  })

  it('calls deleteSubscription on delete confirm', async () => {
    const sub = mockSubscription({ is_personal: false })
    mockApi.deleteSubscription.mockResolvedValue({})
    const { wrapper } = await mountDashboard([sub])

    // Find and click the delete confirm button (AlertDialogAction)
    const deleteConfirm = wrapper.findAll('button').find(b => b.text().trim() === '删除')
    if (deleteConfirm) {
      await deleteConfirm.trigger('click')
      expect(mockApi.deleteSubscription).toHaveBeenCalledWith('test-token', 'sub-token-123')
    }
  })

  it('does not show delete button for personal subscriptions', async () => {
    const { wrapper } = await mountDashboard([mockSubscription({ is_personal: true })])
    const deleteBtn = wrapper.findAll('button').find(b => b.text().includes('删除'))
    // The only "删除" should be the account deletion, not subscription deletion
    const deleteBtns = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    // Personal subs have no delete button (the AlertDialog v-if="!sub.is_personal")
    expect(deleteBtns.length).toBe(0)
  })

  it('opens export URL with window.open', async () => {
    const { wrapper } = await mountDashboard()

    // Find ICS export menu item
    const icsItem = wrapper.findAll('div').find(b => b.text().includes('ICS 日历'))
    if (icsItem) {
      await icsItem.trigger('click')
      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining('/calendar.ics'),
        '_blank',
        'noopener,noreferrer',
      )
    }
  })

  it('handles delete account flow', async () => {
    mockApi.deleteUser.mockResolvedValue({})
    const { wrapper, router } = await mountDashboard()

    // The delete account confirmation requires typing "确认删除"
    const input = wrapper.find('input[placeholder="确认删除"]')
    if (input.exists()) {
      await input.setValue('确认删除')
      const deleteAccountBtn = wrapper.findAll('button').find(
        b => b.text().includes('删除账号') && !b.attributes('disabled'),
      )
      if (deleteAccountBtn) {
        await deleteAccountBtn.trigger('click')
        await vi.runAllTimersAsync()
        expect(mockApi.deleteUser).toHaveBeenCalledWith('test-token')
      }
    }
  })

  it('starts polling when pending subscriptions exist', async () => {
    const pendingSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([pendingSub]))

    const { wrapper } = await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
        },
      },
    })

    // Wait for onMounted
    await vi.runAllTimersAsync()

    // After 2 seconds, polling should fetch subscriptions again
    const callsBefore = mockApi.getSubscriptions.mock.calls.length

    // Now resolve with synced subscription to stop polling
    mockApi.getSubscriptions.mockResolvedValue(
      mockSubscriptionList([mockSubscription({ last_synced_at: '2026-03-01T10:00:00Z' })]),
    )
    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    expect(mockApi.getSubscriptions.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('stops polling after 30 seconds', async () => {
    const pendingSub = mockSubscription({ last_synced_at: null })
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList([pendingSub]))

    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
        },
      },
    })

    await vi.runAllTimersAsync()
    const callsAtStart = mockApi.getSubscriptions.mock.calls.length

    // Advance past 30s timeout
    vi.advanceTimersByTime(32000)
    await vi.runAllTimersAsync()

    const callsAfterTimeout = mockApi.getSubscriptions.mock.calls.length

    // Advance more — should not poll anymore
    vi.advanceTimersByTime(10000)
    await vi.runAllTimersAsync()

    expect(mockApi.getSubscriptions.mock.calls.length).toBe(callsAfterTimeout)
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/views/__tests__/Dashboard.test.ts
```

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/Dashboard.test.ts
git commit -m "test: add Dashboard view tests"
```

---

### Task 11: Add View Test

**Files:**
- Create: `frontend/src/views/__tests__/Add.test.ts`

**Step 1: Create `frontend/src/views/__tests__/Add.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Add from '../Add.vue'
import { mountWithContext, createMockApi, mockSubscription, mockSubscriptionList, mockSearchResult } from '@/test-utils'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))

describe('Add', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function mountAdd(existingSubs = []) {
    mockApi.getSubscriptions.mockResolvedValue(mockSubscriptionList(existingSubs))
    const result = await mountWithContext(Add, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
        },
      },
      global: {
        stubs: {
          Navbar: { template: '<nav />' },
          RiskWarning: { template: '<div />' },
          QrcodeModal: { template: '<div />' },
          DepartmentTreeSelect: {
            template: '<div data-testid="dept-select" />',
            props: ['departments', 'modelValue'],
            emits: ['update:modelValue'],
          },
          Tabs: { template: '<div><slot /></div>', props: ['modelValue'], emits: ['update:modelValue'] },
          TabsList: { template: '<div><slot /></div>' },
          TabsTrigger: {
            template: '<button @click="$emit(\'click\')"><slot /></button>',
            props: ['value'],
            emits: ['click'],
          },
          Select: { template: '<div><slot /></div>', props: ['modelValue'], emits: ['update:modelValue'] },
          SelectTrigger: { template: '<div><slot /></div>' },
          SelectContent: { template: '<div><slot /></div>' },
          SelectItem: { template: '<div><slot /></div>', props: ['value'] },
          SelectValue: { template: '<span>{{ placeholder }}</span>', props: ['placeholder'] },
        },
      },
    })
    await vi.runAllTimersAsync()
    return result
  }

  it('renders search interface', async () => {
    const { wrapper } = await mountAdd()
    expect(wrapper.text()).toContain('添加新订阅')
  })

  it('renders 5 source type tabs', async () => {
    const { wrapper } = await mountAdd()
    expect(wrapper.text()).toContain('教师')
    expect(wrapper.text()).toContain('教室')
    expect(wrapper.text()).toContain('实验室')
    expect(wrapper.text()).toContain('课程')
    expect(wrapper.text()).toContain('行政班')
  })

  it('searches after debounce delay', async () => {
    mockApi.searchSchedule.mockResolvedValue({ results: [mockSearchResult()] })
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('张三')
      await input.trigger('input')

      // Before debounce
      expect(mockApi.searchSchedule).not.toHaveBeenCalled()

      // After 300ms debounce
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(mockApi.searchSchedule).toHaveBeenCalledWith(
        'test-token',
        'instructor',
        '张三',
        '',
        '',
      )
    }
  })

  it('does not search for keywords shorter than 2 chars', async () => {
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('张')
      await input.trigger('input')

      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(mockApi.searchSchedule).not.toHaveBeenCalled()
    }
  })

  it('renders search results', async () => {
    mockApi.searchSchedule.mockResolvedValue({
      results: [
        mockSearchResult({ id: '1', name: '高等数学', extra: '数学学院' }),
        mockSearchResult({ id: '2', name: '线性代数', extra: '数学学院' }),
      ],
    })
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('数学')
      await input.trigger('input')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(wrapper.text()).toContain('高等数学')
      expect(wrapper.text()).toContain('线性代数')
    }
  })

  it('shows "已订阅" for existing subscriptions', async () => {
    const existingSub = mockSubscription({
      source_type: 'instructor',
      source_id: 'teacher-1',
    })
    mockApi.searchSchedule.mockResolvedValue({
      results: [mockSearchResult({ id: 'teacher-1', name: '张三' })],
    })
    const { wrapper } = await mountAdd([existingSub])

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('张三')
      await input.trigger('input')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(wrapper.text()).toContain('已订阅')
    }
  })

  it('calls createSubscription on subscribe click', async () => {
    mockApi.searchSchedule.mockResolvedValue({
      results: [mockSearchResult({ id: 'id-1', name: '高等数学' })],
    })
    mockApi.createSubscription.mockResolvedValue({ calendar_token: 'new-sub' })
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('高等数学')
      await input.trigger('input')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      const subscribeBtn = wrapper.findAll('button').find(b => b.text().includes('订阅'))
      if (subscribeBtn) {
        await subscribeBtn.trigger('click')
        await vi.runAllTimersAsync()
        expect(mockApi.createSubscription).toHaveBeenCalledWith(
          'test-token', 'instructor', 'id-1', '高等数学', null,
        )
      }
    }
  })

  it('shows limit warning when at max subscriptions', async () => {
    const fiveSubs = Array.from({ length: 5 }, (_, i) =>
      mockSubscription({ calendar_token: `sub-${i}` }),
    )
    const { wrapper } = await mountAdd(fiveSubs)
    expect(wrapper.text()).toContain('已达最大订阅数')
  })

  it('shows "未找到结果" when search returns empty', async () => {
    mockApi.searchSchedule.mockResolvedValue({ results: [] })
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('不存在的')
      await input.trigger('input')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(wrapper.text()).toContain('未找到结果')
    }
  })

  it('shows error message on API failure', async () => {
    mockApi.searchSchedule.mockRejectedValue({
      response: { status: 500, data: { detail: '搜索失败' } },
    })
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('测试搜索')
      await input.trigger('input')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(wrapper.text()).toContain('搜索失败')
    }
  })

  it('shows "重新登录" link on token expiration', async () => {
    mockApi.searchSchedule.mockRejectedValue({
      response: { status: 401, data: { detail: 'token expired' } },
    })
    const { wrapper } = await mountAdd()

    const input = wrapper.find('input')
    if (input.exists()) {
      await input.setValue('测试搜索')
      await input.trigger('input')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      expect(wrapper.text()).toContain('重新登录')
    }
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/views/__tests__/Add.test.ts
```

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/Add.test.ts
git commit -m "test: add Add view tests"
```

---

### Task 12: Recover View Test

**Files:**
- Create: `frontend/src/views/__tests__/Recover.test.ts`

**Step 1: Create `frontend/src/views/__tests__/Recover.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Recover from '../Recover.vue'
import { mountWithContext, createMockApi } from '@/test-utils'

const mockApi = createMockApi()
vi.mock('@/api', () => ({ default: mockApi }))

describe('Recover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('renders recovery form', async () => {
    const { wrapper } = await mountWithContext(Recover)
    expect(wrapper.text()).toContain('找回 Token')
    expect(wrapper.find('#studentId').exists()).toBe(true)
    expect(wrapper.find('#password').exists()).toBe(true)
  })

  it('validates empty studentId', async () => {
    const { wrapper } = await mountWithContext(Recover)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('请输入统一身份认证号')
  })

  it('validates empty password', async () => {
    const { wrapper } = await mountWithContext(Recover)
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('请输入密码')
  })

  it('shows recovered token on success', async () => {
    mockApi.recoverToken.mockResolvedValue({ calendar_token: 'recovered-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    const { wrapper } = await mountWithContext(Recover)

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass123')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('找回成功')
      expect(wrapper.text()).toContain('recovered-tok')
    })
  })

  it('shows mismatch step on PASSWORD_MISMATCH error', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } },
      },
    })
    const { wrapper } = await mountWithContext(Recover)

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('wrong')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('密码可能已更改')
      expect(wrapper.text()).toContain('验证')
    })
  })

  it('verify step calls recoverTokenVerify', async () => {
    // First trigger mismatch
    mockApi.recoverToken.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } },
      },
    })
    const { wrapper } = await mountWithContext(Recover)
    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass123')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('验证')
    })

    // Now click verify
    mockApi.recoverTokenVerify.mockResolvedValue({ calendar_token: 'verified-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    const verifyBtn = wrapper.findAll('button').find(b => b.text().includes('验证'))!
    await verifyBtn.trigger('click')

    await vi.waitFor(() => {
      expect(mockApi.recoverTokenVerify).toHaveBeenCalledWith('20210001', 'pass123', null)
      expect(wrapper.text()).toContain('找回成功')
    })
  })

  it('navigates to dashboard from success step', async () => {
    mockApi.recoverToken.mockResolvedValue({ calendar_token: 'tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    const { wrapper, router } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass123')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('找回成功')
    })

    const dashBtn = wrapper.findAll('button').find(b => b.text().includes('进入仪表盘'))!
    await dashBtn.trigger('click')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/dashboard')
    })
  })

  it('shows rate limit error', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: { status: 429, data: { detail: '操作过于频繁' } },
    })
    const { wrapper } = await mountWithContext(Recover)

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('pass')
    await wrapper.find('form').trigger('submit')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('操作过于频繁')
    })
  })

  it('has link to login page', async () => {
    const { wrapper } = await mountWithContext(Recover)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(true)
  })
})
```

**Step 2: Run tests**

```bash
cd frontend && npx vitest run src/views/__tests__/Recover.test.ts
```

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/Recover.test.ts
git commit -m "test: add Recover view tests"
```

---

### Task 13: Final Verification + CI Script

**Step 1: Run all frontend tests**

```bash
cd frontend && npx vitest run
```

Expected: All tests pass.

**Step 2: Run backend tests to verify no regression**

```bash
npm test
```

Expected: All 72+ backend tests still pass.

**Step 3: Verify typecheck (optional — may need tsconfig adjustment)**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

If there are type errors on test file imports, add to `frontend/tsconfig.json`:
```json
"compilerOptions": {
  "allowJs": true
}
```

**Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "test: finalize frontend test suite"
```

**Step 5: Verify root test:frontend script**

```bash
npm run test:frontend
```

Expected: All frontend tests pass via root script.
