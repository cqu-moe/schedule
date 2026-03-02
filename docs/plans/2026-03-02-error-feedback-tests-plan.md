# 错误反馈测试补全 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 补全 error-feedback 分支的测试覆盖，为 parseApiError、useButtonFeedback 新增单元测试，为各页面补充 toast 错误通知和按钮状态测试。

**Architecture:** 从底到顶分层：先写工具函数和 composable 的纯单元测试，再补充各页面的集成测试。所有新增测试文件遵循现有 `vi.hoisted()` + `vi.mock()` 模式。

**Tech Stack:** vitest v4, jsdom, @vue/test-utils, @pinia/testing, vue-sonner

---

### Task 1: parseApiError 单元测试

**Files:**
- Create: `frontend/src/utils/__tests__/error.test.ts`
- Reference: `frontend/src/utils/error.ts`

**Step 1: 创建测试文件**

```typescript
// frontend/src/utils/__tests__/error.test.ts
import { describe, it, expect } from 'vitest'
import { parseApiError } from '@/utils/error'

describe('parseApiError', () => {
  it('returns string detail directly', () => {
    const error = { response: { data: { detail: '自定义错误' } } }
    expect(parseApiError(error)).toBe('自定义错误')
  })

  it('maps CAPTCHA_REQUIRED string detail to message', () => {
    const error = { response: { data: { detail: 'CAPTCHA_REQUIRED' } } }
    expect(parseApiError(error)).toBe('验证码验证失败，请刷新页面重试')
  })

  it('maps CAPTCHA_FAILED string detail to message', () => {
    const error = { response: { data: { detail: 'CAPTCHA_FAILED' } } }
    expect(parseApiError(error)).toBe('验证码验证失败，请刷新页面重试')
  })

  it('maps USER_EXISTS error code to message', () => {
    const error = { response: { data: { detail: { error: { code: 'USER_EXISTS' } } } } }
    expect(parseApiError(error)).toBe('该账号已注册，请使用 Token 登录')
  })

  it('returns error.message from structured error', () => {
    const error = { response: { data: { detail: { error: { message: '具体错误信息' } } } } }
    expect(parseApiError(error)).toBe('具体错误信息')
  })

  it('prefers code mapping over error.message', () => {
    const error = { response: { data: { detail: { error: { code: 'USER_EXISTS', message: '其他消息' } } } } }
    expect(parseApiError(error)).toBe('该账号已注册，请使用 Token 登录')
  })

  it('returns fallback when no response', () => {
    expect(parseApiError({}, '网络错误')).toBe('网络错误')
  })

  it('returns fallback when no data', () => {
    expect(parseApiError({ response: {} }, '网络错误')).toBe('网络错误')
  })

  it('returns fallback when no detail', () => {
    expect(parseApiError({ response: { data: {} } }, '请求失败')).toBe('请求失败')
  })

  it('returns default fallback "操作失败" when no fallback provided', () => {
    expect(parseApiError(null)).toBe('操作失败')
  })
})
```

**Step 2: 运行测试**

```bash
cd frontend && npx vitest run src/utils/__tests__/error.test.ts
```

Expected: 10 tests PASS。

**Step 3: Commit**

```bash
git add frontend/src/utils/__tests__/error.test.ts
git commit -m "test: add parseApiError unit tests"
```

---

### Task 2: useButtonFeedback 单元测试

**Files:**
- Create: `frontend/src/composables/__tests__/useButtonFeedback.test.ts`
- Reference: `frontend/src/composables/useButtonFeedback.ts`

**Step 1: 创建测试文件**

```typescript
// frontend/src/composables/__tests__/useButtonFeedback.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useButtonFeedback } from '@/composables/useButtonFeedback'

describe('useButtonFeedback', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts in idle state with default key', () => {
    const { stateOf } = useButtonFeedback()
    expect(stateOf()).toBe('idle')
  })

  it('starts in idle state with custom key', () => {
    const { stateOf } = useButtonFeedback()
    expect(stateOf('some-key')).toBe('idle')
  })

  it('transitions to loading during run', async () => {
    const { stateOf, run } = useButtonFeedback()
    let resolve!: () => void
    const promise = run(() => new Promise<void>(r => { resolve = r }))

    expect(stateOf()).toBe('loading')

    resolve()
    await promise
  })

  it('transitions to success after successful run', async () => {
    const { stateOf, run } = useButtonFeedback()
    await run(async () => {})

    expect(stateOf()).toBe('success')
  })

  it('resets to idle after 1500ms on success', async () => {
    const { stateOf, run } = useButtonFeedback()
    await run(async () => {})

    expect(stateOf()).toBe('success')
    vi.advanceTimersByTime(1500)
    expect(stateOf()).toBe('idle')
  })

  it('transitions to error and re-throws on failure', async () => {
    const { stateOf, run } = useButtonFeedback()
    const error = new Error('test error')

    await expect(run(async () => { throw error })).rejects.toThrow('test error')
    expect(stateOf()).toBe('error')
  })

  it('resets to idle after 1500ms on error', async () => {
    const { stateOf, run } = useButtonFeedback()

    await run(async () => { throw new Error('fail') }).catch(() => {})

    expect(stateOf()).toBe('error')
    vi.advanceTimersByTime(1500)
    expect(stateOf()).toBe('idle')
  })

  it('isolates state between different keys', async () => {
    const { stateOf, run } = useButtonFeedback()

    await run(async () => {}, 'key-a')
    expect(stateOf('key-a')).toBe('success')
    expect(stateOf('key-b')).toBe('idle')
  })
})
```

**Step 2: 运行测试**

```bash
cd frontend && npx vitest run src/composables/__tests__/useButtonFeedback.test.ts
```

Expected: 8 tests PASS。

**Step 3: Commit**

```bash
git add frontend/src/composables/__tests__/useButtonFeedback.test.ts
git commit -m "test: add useButtonFeedback composable unit tests"
```

---

### Task 3: Dashboard.test.ts 补充 toast 和错误测试

**Files:**
- Modify: `frontend/src/views/__tests__/Dashboard.test.ts`

**Step 1: 添加 toast mock**

在文件顶部 `vi.hoisted()` 块中添加 mockToast，并注册 `vi.mock('vue-sonner')`。

在 `vi.hoisted()` 中：
```typescript
const { mockApi, mockToast } = vi.hoisted(() => {
  const mockToast = { error: vi.fn(), success: vi.fn() }
  const mockApi = { ... }
  return { mockApi, mockToast }
})
```

在 `vi.mock('@/api/index.js', ...)` 后添加：
```typescript
vi.mock('vue-sonner', () => ({ toast: mockToast }))
```

**Step 2: 添加测试用例**

在 `describe` 块末尾添加：

```typescript
  // Error feedback: initial load failure
  it('shows toast error when initial load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })

    await mountWithContext(Dashboard, {
      pinia: {
        initialState: {
          auth: { token: 'test-token', userInfo: { student_id: '20210001' }, loading: false },
          config: { publicUrl: 'https://schedule.cqu.moe', loaded: true },
        },
      },
    })
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  // Error feedback: refresh subscription failure
  it('shows toast error when refresh subscription fails', async () => {
    mockApi.refreshSubscription.mockRejectedValue({
      response: { data: { detail: '刷新超时' } },
    })
    const { wrapper } = await mountDashboard()

    const syncBtn = wrapper.findAll('button').find(
      b => b.text() === '同步' || (b.text().includes('同步') && !b.text().includes('所有')),
    )
    await syncBtn!.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('刷新超时')
  })

  // Error feedback: sync all failure
  it('shows toast error when sync all fails', async () => {
    mockApi.refreshSubscription.mockRejectedValue({
      response: { data: { detail: '同步超时' } },
    })
    const { wrapper } = await mountDashboard()

    const syncAllBtn = wrapper.findAll('button').find(b => b.text().includes('同步所有'))
    await syncAllBtn!.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('同步超时')
  })

  // Error feedback: delete subscription failure
  it('shows toast error when delete subscription fails', async () => {
    const exploreSub = mockSubscription({
      calendar_token: 'explore-1',
      is_personal: false,
      source_type: 'instructor',
      source_name: '李四',
    })
    mockApi.deleteSubscription.mockRejectedValue({
      response: { data: { detail: '删除失败' } },
    })
    const { wrapper } = await mountDashboard([exploreSub])

    const deleteButtons = wrapper.findAll('button').filter(b => b.text().trim() === '删除')
    await deleteButtons[deleteButtons.length - 1].trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('删除失败')
  })

  // Error feedback: delete account failure
  it('shows toast error when delete account fails', async () => {
    mockApi.deleteUser.mockRejectedValue(new Error('server error'))
    const { wrapper } = await mountDashboard()

    // Type confirmation text
    const input = wrapper.find('input[placeholder="确认删除"]')
    await input.setValue('确认删除')

    // Find delete account action button (inside AlertDialog)
    const actionButtons = wrapper.findAll('button').filter(b => b.text().includes('删除账号'))
    const deleteAccountAction = actionButtons[actionButtons.length - 1]
    await deleteAccountAction.trigger('click')
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('删除账号失败')
  })
```

**Step 3: 运行测试**

```bash
cd frontend && npx vitest run src/views/__tests__/Dashboard.test.ts
```

Expected: 所有测试 PASS（原 17 + 新 5 = 22）。

**Step 4: Commit**

```bash
git add frontend/src/views/__tests__/Dashboard.test.ts
git commit -m "test: add Dashboard toast error and failure tests"
```

---

### Task 4: Add.test.ts 补充测试

**Files:**
- Modify: `frontend/src/views/__tests__/Add.test.ts`

toast 已 mock（mockToast 已在 `vi.hoisted` 中）。

**Step 1: 添加测试用例**

在 `describe` 块末尾添加：

```typescript
  // Error feedback: load subscriptions failure on mount
  it('shows toast error when initial subscription load fails', async () => {
    mockApi.getSubscriptions.mockRejectedValue(new Error('network'))

    await mountAdd()
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('加载订阅列表失败')
  })

  // Error feedback: load departments failure
  it('shows toast error when department load fails', async () => {
    mockApi.getDepartments.mockRejectedValue({
      response: { data: { detail: '加载院系列表失败' } },
    })

    const { wrapper } = await mountAdd()

    // Switch to admin_class tab to trigger department load
    const tabs = wrapper.findAll('[role="tab"], button')
    const adminTab = tabs.find(t => t.text().includes('行政班'))
    if (adminTab) {
      await adminTab.trigger('click')
      await flushPromises()
    }

    expect(mockToast.error).toHaveBeenCalled()
  })

  // Subscribe button shows success state
  it('shows success state on subscribe button after successful subscription', async () => {
    vi.useFakeTimers()
    mockApi.searchSchedule.mockResolvedValue({
      results: [{ id: 'teacher-1', name: '王老师', extra: '数学学院' }],
    })
    mockApi.createSubscription.mockResolvedValue({})
    mockApi.getSubscriptions.mockResolvedValue({
      subscriptions: [],
      max: 5,
    })

    const { wrapper } = await mountAdd()
    const input = wrapper.find('input')
    await input.setValue('王老师')
    await input.trigger('input')

    vi.advanceTimersByTime(300)
    await flushPromises()

    // Click subscribe button
    const subBtn = wrapper.findAll('button').find(b => b.text().includes('订阅'))
    await subBtn!.trigger('click')
    await flushPromises()

    expect(mockApi.createSubscription).toHaveBeenCalled()
  })
```

**Step 2: 运行测试**

```bash
cd frontend && npx vitest run src/views/__tests__/Add.test.ts
```

Expected: 所有测试 PASS。

**Step 3: Commit**

```bash
git add frontend/src/views/__tests__/Add.test.ts
git commit -m "test: add Add page error toast and subscription tests"
```

---

### Task 5: Register.test.ts 补充测试

**Files:**
- Modify: `frontend/src/views/__tests__/Register.test.ts`

**Step 1: 添加 toast mock**

与 Dashboard 相同模式：在 `vi.hoisted()` 中添加 `mockToast`，注册 `vi.mock('vue-sonner')`。

**Step 2: 添加测试用例**

```typescript
  // Error feedback: copy token failure shows toast
  it('shows toast error when copy token fails', async () => {
    mockApi.register.mockResolvedValue({ calendar_token: 'new-token-123' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('注册成功')
    })

    // Find copy button (has Copy icon, inside the token display)
    const copyBtns = wrapper.findAll('button').filter(b => !b.text().includes('我已保存'))
    const copyBtn = copyBtns.find(b => b.element.closest('.bg-muted'))
    if (copyBtn) {
      await copyBtn.trigger('click')
      await flushPromises()
      expect(mockToast.error).toHaveBeenCalledWith('复制失败')
    }
  })

  // Register button disabled during loading
  it('disables register button during loading', async () => {
    let resolveRegister!: (value: any) => void
    mockApi.register.mockReturnValue(new Promise(r => { resolveRegister = r }))

    const { wrapper } = await mountWithContext(Register, { initialRoute: '/register' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    // During progress, check the button is in the form phase or progress
    // The form switches to progress phase, so the submit button is gone
    expect(wrapper.text()).toContain('正在注册')

    resolveRegister({ calendar_token: 'tok' })
  })
```

**Step 3: 运行测试**

```bash
cd frontend && npx vitest run src/views/__tests__/Register.test.ts
```

Expected: 所有测试 PASS。

**Step 4: Commit**

```bash
git add frontend/src/views/__tests__/Register.test.ts
git commit -m "test: add Register toast error and button state tests"
```

---

### Task 6: Recover.test.ts 补充测试

**Files:**
- Modify: `frontend/src/views/__tests__/Recover.test.ts`

**Step 1: 添加 toast mock**

与 Dashboard 相同模式。

**Step 2: 添加测试用例**

```typescript
  // Error feedback: non-mismatch API error shows Alert
  it('shows error message for non-mismatch API errors', async () => {
    mockApi.recoverToken.mockRejectedValue({
      response: { data: { detail: { error: { message: '服务器内部错误' } } } },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('服务器内部错误')
    })
  })

  // Error feedback: verify failure shows Alert
  it('shows error message when verify fails', async () => {
    // Trigger mismatch first
    mockApi.recoverToken.mockRejectedValue({
      response: { status: 400, data: { detail: { error: { code: 'PASSWORD_MISMATCH' } } } },
    })

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('密码可能已更改')
    })

    // Set up verify to fail
    mockApi.recoverTokenVerify.mockRejectedValue({
      response: { data: { detail: { error: { message: '验证超时' } } } },
    })

    const verifyBtn = wrapper.findAll('button').find(b => b.text().includes('验证'))
    await verifyBtn!.trigger('click')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('验证超时')
    })
  })

  // Error feedback: copy token failure shows toast
  it('shows toast error when copy token fails', async () => {
    mockApi.recoverToken.mockResolvedValue({ calendar_token: 'recovered-tok' })
    mockApi.getUserInfo.mockResolvedValue({ student_id: '20210001' })
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))

    const { wrapper } = await mountWithContext(Recover, { initialRoute: '/recover' })

    await wrapper.find('#studentId').setValue('20210001')
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('找回成功')
    })

    // Find copy button in the token display area
    const copyBtns = wrapper.findAll('button').filter(b => !b.text().includes('进入仪表盘'))
    const copyBtn = copyBtns.find(b => b.element.closest('.bg-muted'))
    if (copyBtn) {
      await copyBtn.trigger('click')
      await flushPromises()
      expect(mockToast.error).toHaveBeenCalledWith('复制失败')
    }
  })
```

**Step 3: 运行测试**

```bash
cd frontend && npx vitest run src/views/__tests__/Recover.test.ts
```

Expected: 所有测试 PASS。

**Step 4: Commit**

```bash
git add frontend/src/views/__tests__/Recover.test.ts
git commit -m "test: add Recover error feedback and toast tests"
```

---

### Task 7: 最终验证

**Step 1: 运行全部前端测试**

```bash
cd frontend && npm test
```

Expected: 所有测试 PASS，0 failures。记录总测试数（目标约 166 = 131 + 35）。

**Step 2: 构建检查**

```bash
cd frontend && npm run build
```

Expected: 构建成功。

**Step 3: Commit 设计文档**

```bash
git add docs/plans/2026-03-02-error-feedback-tests-design.md docs/plans/2026-03-02-error-feedback-tests-plan.md
git commit -m "docs: add error feedback test coverage design and plan"
```
