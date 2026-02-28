# 前端错误提示增强设计

## 问题

当前前端错误提示太弱：
- 所有错误都是内联小字红色文本 (`text-sm text-destructive`)，容易被忽略
- 没有 toast/通知库，全靠 `<p>` 标签
- 多处操作静默失败（加载订阅列表、删除订阅、复制链接等）
- 错误解析逻辑分散重复在每个页面中

## 方案

三层反馈体系 + 统一错误解析。

### 1. Toast 通知 (sonner)

用 `vue-sonner`（shadcn-vue 生态）在右下角弹出通知，用于所有非表单操作的成功/失败反馈。

集成方式：
- `App.vue` 挂载 `<Toaster position="bottom-right" richColors :duration="3000" />`
- 各页面直接 `import { toast } from 'vue-sonner'` 调用

### 2. 内联 Alert

表单提交错误用 shadcn-vue `Alert` 组件（已有）替换当前的 `<p>` 标签，更醒目。不加关闭按钮，用户重新操作时自动清空。

```html
<Alert v-if="errorMessage" variant="destructive">
  <AlertDescription>{{ errorMessage }}</AlertDescription>
</Alert>
```

### 3. 统一错误解析工具

`frontend/src/utils/error.ts`：

```typescript
parseApiError(error, fallbackMessage?: string): string
```

解析优先级：
1. `error.response.data.detail.error.message`
2. `error.response.data.detail`（字符串）
3. 特殊 code 映射（CAPTCHA_REQUIRED、USER_EXISTS 等）
4. fallbackMessage 或默认 "操作失败"

429 处理保留在 axios interceptor 中。

## 各页面反馈方式

### Login.vue

| 操作 | 方式 |
|---|---|
| Token 登录失败 | Alert |

### Register.vue

| 操作 | 方式 |
|---|---|
| 注册失败 | Alert |
| 注册成功 | Toast |

### Recover.vue

| 操作 | 方式 |
|---|---|
| 找回失败 | Alert |
| 找回成功 | Toast |

### Dashboard.vue

| 操作 | 方式 |
|---|---|
| 加载订阅列表失败（当前静默） | Toast |
| 刷新订阅 成功/失败 | Toast |
| 同步全部课表 成功/失败 | Toast |
| 删除订阅 成功/失败（当前静默） | Toast |
| 删除账号失败 | Toast |
| 复制链接 成功/失败（当前静默） | Toast |

### Add.vue

| 操作 | 方式 |
|---|---|
| 搜索/加载院系失败 | Toast |
| Token 过期（401） | Alert |
| 订阅成功/失败 | Toast |
| 加载订阅列表失败（当前静默） | Toast |
| 验证码配置加载失败（当前静默） | Toast |

## 涉及文件

| 文件 | 变更 |
|---|---|
| `frontend/src/utils/error.ts` | 新增：统一错误解析 |
| `frontend/src/App.vue` | 挂载 `<Toaster />` |
| `frontend/src/views/Login.vue` | `<p>` → Alert |
| `frontend/src/views/Register.vue` | `<p>` → Alert，注册成功 Toast |
| `frontend/src/views/Recover.vue` | `<p>` → Alert，找回成功 Toast |
| `frontend/src/views/Dashboard.vue` | statusMessage → Toast，修复静默失败 |
| `frontend/src/views/Add.vue` | handleApiError → parseApiError + Toast/Alert |
