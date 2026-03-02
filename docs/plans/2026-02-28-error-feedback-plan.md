# 前端错误提示增强 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 sonner Toast + shadcn-vue Alert 替换当前的弱提示，统一错误解析，修复所有静默失败。

**Architecture:** 新增 `utils/error.ts` 统一解析 API 错误响应，App.vue 挂载 sonner `<Toaster />`，表单错误用内联 Alert 组件，后台操作用 Toast 通知。

**Tech Stack:** vue-sonner, shadcn-vue Alert (已有), Vue 3

---

### Task 1: 安装 vue-sonner

**Files:**
- Modify: `frontend/package.json`

**Step 1: 安装依赖**

```bash
cd frontend && npm install vue-sonner
```

**Step 2: 验证安装**

```bash
cd frontend && node -e "require('vue-sonner')" && echo 'OK'
```

**Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): add vue-sonner dependency for toast notifications"
```

---

### Task 2: 创建统一错误解析工具

**Files:**
- Create: `frontend/src/utils/error.ts`

**Step 1: 创建 parseApiError**

```typescript
// frontend/src/utils/error.ts

const CODE_MESSAGES: Record<string, string> = {
  CAPTCHA_REQUIRED: '验证码验证失败，请刷新页面重试',
  CAPTCHA_FAILED: '验证码验证失败，请刷新页面重试',
  USER_EXISTS: '该账号已注册，请使用 Token 登录',
}

export function parseApiError(error: unknown, fallback = '操作失败'): string {
  const resp = (error as any)?.response
  if (!resp?.data) return fallback

  const detail = resp.data.detail
  if (!detail) return fallback

  // detail 是字符串 (含 429 interceptor 处理后的结果)
  if (typeof detail === 'string') {
    return CODE_MESSAGES[detail] || detail
  }

  // detail.error.code 特殊映射
  const code = detail?.error?.code
  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code]
  }

  // detail.error.message
  if (detail?.error?.message) {
    return detail.error.message
  }

  return fallback
}
```

**Step 2: Commit**

```bash
git add frontend/src/utils/error.ts
git commit -m "feat(frontend): add unified API error parser"
```

---

### Task 3: 挂载 Toaster 到 App.vue

**Files:**
- Modify: `frontend/src/App.vue:1-14`

**Step 1: 添加 Toaster 到 App.vue**

在 imports 中添加：
```typescript
import { Toaster } from 'vue-sonner'
```

在 template 的 `<router-view>` 同级添加：
```vue
<Toaster position="bottom-right" rich-colors :duration="3000" />
```

**Step 2: 启动 dev server 验证 Toaster 渲染**

```bash
cd frontend && npm run dev
```

浏览器打开后检查 DOM 中存在 sonner toaster 容器。

**Step 3: Commit**

```bash
git add frontend/src/App.vue
git commit -m "feat(frontend): mount sonner Toaster in App.vue"
```

---

### Task 4: 改造 Login.vue

**Files:**
- Modify: `frontend/src/views/Login.vue:15,39-48`

**Step 1: 替换错误显示为 Alert**

添加 imports：
```typescript
import { Alert, AlertDescription } from '@/components/ui/alert'
```

将第 15 行：
```vue
<p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>
```
替换为：
```vue
<Alert v-if="errorMessage" variant="destructive">
  <AlertDescription>{{ errorMessage }}</AlertDescription>
</Alert>
```

**Step 2: 手动测试**

在登录页输入无效 token，确认 Alert 样式正确显示。

**Step 3: Commit**

```bash
git add frontend/src/views/Login.vue
git commit -m "feat(frontend): use Alert component for login errors"
```

---

### Task 5: 改造 Register.vue

**Files:**
- Modify: `frontend/src/views/Register.vue:29,92-108,130-139,152-192,194-200`

**Step 1: 替换错误显示为 Alert + 添加 Toast**

添加 imports：
```typescript
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseApiError } from '@/utils/error'
```

将第 29 行的 `<p>` 替换为 Alert（同 Task 4 格式）。

**Step 2: 注册成功时弹 Toast**

在 `handleRegister()` 成功分支、`showTokenDialog.value = true` 之前添加：
```typescript
toast.success('注册成功')
```

**Step 3: 验证码配置加载失败时弹 Toast**

将 `onMounted` 中的空 `catch {}` 改为：
```typescript
catch {
  toast.error('验证码配置加载失败')
}
```

**Step 4: 用 parseApiError 替换 auth store 中的重复解析**

修改 `frontend/src/stores/auth.js` 的 `register()` 函数，替换手动错误解析：

```javascript
import { parseApiError } from '@/utils/error'

// register() catch 块简化为：
catch (error) {
  return { success: false, error: parseApiError(error, '注册失败') }
}
```

**Step 5: 手动测试**

1. 注册成功 → Toast "注册成功"
2. 注册失败 → Alert 显示错误
3. 验证码配置加载失败 → Toast 提示

**Step 6: Commit**

```bash
git add frontend/src/views/Register.vue frontend/src/stores/auth.js
git commit -m "feat(frontend): improve Register error feedback with Alert and Toast"
```

---

### Task 6: 改造 Recover.vue

**Files:**
- Modify: `frontend/src/views/Recover.vue:27,43,85-97,114-123,136-172,174-203`

**Step 1: 替换错误显示为 Alert + 添加 Toast**

添加 imports：
```typescript
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseApiError } from '@/utils/error'
```

将第 27 行和第 43 行的两处 `<p>` 替换为 Alert。

**Step 2: 用 parseApiError 简化错误处理**

`handleRecover()` catch 块改为：
```typescript
catch (error) {
  const detail = error.response?.data?.detail
  const code = detail?.error?.code
  if (code === 'PASSWORD_MISMATCH') {
    step.value = 'mismatch'
  } else {
    errorMessage.value = parseApiError(error, '找回失败')
  }
  hcaptchaRef.value?.reset()
}
```

`handleVerify()` catch 块改为：
```typescript
catch (error) {
  errorMessage.value = parseApiError(error, '验证失败')
  hcaptchaRef.value?.reset()
}
```

**Step 3: 找回成功时弹 Toast**

在 `handleRecover()` 和 `handleVerify()` 的成功分支添加：
```typescript
toast.success('找回成功')
```

**Step 4: 验证码配置加载失败时弹 Toast**

将 `onMounted` 中的空 `catch {}` 改为：
```typescript
catch {
  toast.error('验证码配置加载失败')
}
```

**Step 5: 手动测试**

1. 找回成功 → Toast + 显示 token
2. 密码错误 → Alert 或进入 mismatch 步骤
3. 其他错误 → Alert 显示具体消息

**Step 6: Commit**

```bash
git add frontend/src/views/Recover.vue
git commit -m "feat(frontend): improve Recover error feedback with Alert and Toast"
```

---

### Task 7: 改造 Dashboard.vue

**Files:**
- Modify: `frontend/src/views/Dashboard.vue:32-38,217-246,305-383`

**Step 1: 添加 Toast，移除 statusMessage 体系**

添加 imports：
```typescript
import { toast } from 'vue-sonner'
import { parseApiError } from '@/utils/error'
```

删除 `statusMessage` 和 `statusType` 两个 ref 声明。

删除 template 中第 32-38 行的 `<p v-if="statusMessage">` 块。

**Step 2: 改造所有操作为 Toast**

`loadSubscriptions()` — 加载失败提示：
```typescript
catch {
  toast.error('加载订阅列表失败')
}
```

`copyUrl()` — 复制成功/失败提示：
```typescript
async function copyUrl(url, token) {
  try {
    await navigator.clipboard.writeText(url)
    copiedToken.value = token
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedToken.value = null }, 1500)
    toast.success('链接已复制')
  } catch {
    toast.error('复制失败')
  }
}
```

`handleRefreshSub()` — 刷新成功/失败提示：
```typescript
catch (error) {
  toast.error(parseApiError(error, '刷新失败'))
}
```
成功时在 `await authStore.fetchUserInfo()` 后添加：
```typescript
toast.success('订阅已刷新')
```

`handleDeleteSub()` — 删除成功/失败提示：
```typescript
async function handleDeleteSub(subToken) {
  try {
    await api.deleteSubscription(authStore.token, subToken)
    await loadSubscriptions()
    toast.success('订阅已删除')
  } catch (error) {
    toast.error(parseApiError(error, '删除订阅失败'))
  }
}
```

`handleSyncAll()` — 同步成功/失败提示：
```typescript
// 移除 statusMessage.value 赋值，改为：
toast.success('同步成功')
// 和
toast.error(parseApiError(error, '同步失败'))
```

`handleDelete()` — 删除账号失败提示：
```typescript
catch {
  toast.error('删除账号失败')
}
```

**Step 3: 手动测试**

1. 刷新订阅 → Toast 成功/失败
2. 同步全部 → Toast 成功/失败
3. 删除订阅 → Toast 成功
4. 复制链接 → Toast "链接已复制"
5. 页面加载失败 → Toast 错误提示

**Step 4: Commit**

```bash
git add frontend/src/views/Dashboard.vue
git commit -m "feat(frontend): replace statusMessage with Toast notifications in Dashboard"
```

---

### Task 8: 改造 Add.vue

**Files:**
- Modify: `frontend/src/views/Add.vue:120-131,137-151,191-201,230-237,254-276,278-305,307-315,317-326`

**Step 1: 添加 Toast，改造错误处理**

添加 imports：
```typescript
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseApiError } from '@/utils/error'
```

**Step 2: Token 过期用 Alert，其他用 Toast**

替换 `handleApiError()` 函数：
```typescript
function handleApiError(err: unknown, fallbackMessage: string) {
  const msg = parseApiError(err, fallbackMessage)
  const resp = (err as any)?.response
  if (resp?.status === 401 || /token expired/i.test(msg)) {
    errorMessage.value = msg
    isTokenExpired.value = true
  } else {
    toast.error(msg)
  }
}
```

**Step 3: 将 token 过期的 `<p>` 改为 Alert**

将第 120-131 行替换为：
```vue
<div v-if="errorMessage" class="mt-4">
  <Alert variant="destructive">
    <AlertDescription>
      {{ errorMessage }}
      <Button
        v-if="isTokenExpired"
        variant="link"
        size="sm"
        class="px-0 text-destructive cursor-pointer"
        @click="$router.push('/login')"
      >
        重新登录
      </Button>
    </AlertDescription>
  </Alert>
</div>
```

**Step 4: 订阅成功弹 Toast**

在 `handleSubscribe()` 的 `await loadSubscriptions()` 后添加：
```typescript
toast.success('订阅成功')
```

**Step 5: 修复静默失败**

`loadSubscriptions()` 失败：
```typescript
catch {
  toast.error('加载订阅列表失败')
}
```

`onMounted` 验证码配置加载失败：
```typescript
catch {
  toast.error('验证码配置加载失败')
}
```

**Step 6: 手动测试**

1. 搜索失败 → Toast 错误
2. 订阅成功 → Toast "订阅成功"
3. Token 过期 → Alert + 重新登录链接
4. 加载失败 → Toast 提示

**Step 7: Commit**

```bash
git add frontend/src/views/Add.vue
git commit -m "feat(frontend): improve Add page error feedback with Alert and Toast"
```

---

### Task 9: 最终验证

**Step 1: TypeScript 检查**

```bash
cd frontend && npx vue-tsc --noEmit
```

Expected: 无错误。

**Step 2: 构建检查**

```bash
cd frontend && npm run build
```

Expected: 构建成功。

**Step 3: 端到端手动验证**

启动 dev server 并逐页检查：
1. Login — 无效 token → Alert 醒目提示
2. Register — 注册流程成功/失败 → Alert + Toast
3. Recover — 找回流程 → Alert + Toast
4. Dashboard — 所有操作 → Toast 反馈，无静默失败
5. Add — 搜索/订阅 → Toast，Token 过期 → Alert

**Step 4: Commit design doc**

```bash
git add docs/plans/2026-02-28-error-feedback-design.md docs/plans/2026-02-28-error-feedback-plan.md
git commit -m "docs: add error feedback enhancement design and implementation plan"
```
