# 按钮状态反馈 + Toast 样式修复设计

## 问题

1. Toast 没有样式（缺少 CSS），显示为纯文本
2. 有明确按钮触发的操作不应该用 Toast 反馈，应该在按钮上直接显示结果

## 方案

### 1. `useButtonFeedback()` composable

`frontend/src/composables/useButtonFeedback.ts`

```typescript
const { state, run } = useButtonFeedback()
// state: 'idle' | 'loading' | 'success' | 'error'
// run(asyncFn): 执行异步操作，自动管理状态
```

状态流转：`idle → loading → success/error (1.5s) → idle`

按钮视觉：

| state | 图标 | 颜色 | 文字 |
|---|---|---|---|
| idle | 原始 | 默认 | 原始 |
| loading | Loader2 旋转 | 默认 | 原始 |
| success | Check ✓ | 绿色 | 自定义（"已复制"等） |
| error | X ✗ | 红色 | "失败" |

error 状态下同时弹 Toast 显示具体错误信息。

### 2. Toast 样式修复

用 `npx shadcn-vue@latest add sonner` 生成 shadcn-vue Sonner 封装组件，替换直接从 vue-sonner 导入的 Toaster。自动适配项目 stone 配色和暗色模式。

App.vue 改为 `import { Sonner as Toaster } from '@/components/ui/sonner'`。

## 各页面反馈方式

### Dashboard.vue

| 操作 | 成功 | 失败 |
|---|---|---|
| 复制链接 | 按钮 ✓ "已复制" | 按钮 ✗ "失败" |
| 刷新订阅 | 按钮 ✓ "已刷新" | 按钮 ✗ "失败" + Toast 详情 |
| 删除订阅 | 按钮 ✓ "已删除" | 按钮 ✗ "失败" + Toast 详情 |
| 同步全部 | 按钮 ✓ "已同步" | 按钮 ✗ "失败" + Toast 详情 |
| 删除账号 | 成功跳转 | Toast |
| 加载列表 | — | Toast |

### Add.vue

| 操作 | 成功 | 失败 |
|---|---|---|
| 订阅 | 按钮 ✓ "已订阅" | Toast（非401）/ Alert（401）|
| 搜索/加载 | — | Toast |

### Register.vue

| 操作 | 成功 |
|---|---|
| 注册 | 按钮 ✓ "注册成功" → token 对话框 |

### Recover.vue

| 操作 | 成功 |
|---|---|
| 找回/验证 | 按钮 ✓ "找回成功" → success 步骤 |

## 涉及文件

| 文件 | 变更 |
|---|---|
| `frontend/src/composables/useButtonFeedback.ts` | 新增 |
| `frontend/src/components/ui/sonner/` | 新增（shadcn-vue CLI 生成）|
| `frontend/src/App.vue` | Toaster 导入改为 shadcn-vue Sonner |
| `frontend/src/views/Dashboard.vue` | toast.success → useButtonFeedback |
| `frontend/src/views/Add.vue` | 订阅按钮用 useButtonFeedback |
| `frontend/src/views/Register.vue` | 注册按钮用 useButtonFeedback |
| `frontend/src/views/Recover.vue` | 找回按钮用 useButtonFeedback |
