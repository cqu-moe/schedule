# 错误反馈测试补全设计

## 问题

error-feedback 分支实现了三层反馈体系（Toast + Alert + 按钮状态），但测试覆盖不完整：
- `useButtonFeedback` composable 无单元测试
- `parseApiError` 工具函数无单元测试
- 多数 toast 错误通知未验证（仅 Add.test.ts mock 了 vue-sonner）
- 按钮状态变化未显式测试

## 方案

从底到顶分层补全测试。

### 1. parseApiError 单元测试

新建 `frontend/src/utils/__tests__/error.test.ts`，覆盖所有分支：

| 场景 | 输入 | 期望输出 |
|---|---|---|
| 字符串 detail | `{ detail: '自定义错误' }` | `'自定义错误'` |
| 字符串 detail 匹配 CODE_MESSAGES | `{ detail: 'CAPTCHA_REQUIRED' }` | `'验证码验证失败...'` |
| error.code 匹配 | `{ detail: { error: { code: 'USER_EXISTS' } } }` | `'该账号已注册...'` |
| error.message | `{ detail: { error: { message: '具体错误' } } }` | `'具体错误'` |
| 无 response | `{}` | fallback |
| 无 detail | `{ response: { data: {} } }` | fallback |
| 默认 fallback | 无第二参数 | `'操作失败'` |

约 10 个测试。

### 2. useButtonFeedback 单元测试

新建 `frontend/src/composables/__tests__/useButtonFeedback.test.ts`，覆盖：

- 初始状态 idle
- 成功流程：idle → loading → success → idle (1500ms)
- 失败流程：idle → loading → error → idle (1500ms)，re-throw
- 多 key 隔离
- 默认 key `'_'`

约 8 个测试。

### 3. Dashboard.test.ts 补充

mock `vue-sonner`，新增：

| 测试 | 验证 |
|---|---|
| 刷新订阅失败 | `toast.error` 被调用 |
| 删除订阅失败 | `toast.error` 被调用 |
| 同步全部失败 | `toast.error` 被调用 |
| 初始加载失败 | `toast.error('加载订阅列表失败')` |
| 删除账号失败 | `toast.error('删除账号失败')` |
| 同步按钮 loading 时 disabled | button disabled 属性 |

约 6 个测试。

### 4. Add.test.ts 补充

toast 已 mock，新增：

| 测试 | 验证 |
|---|---|
| 加载订阅列表失败 | `toast.error('加载订阅列表失败')` |
| 加载院系列表失败 | `toast.error` 被调用 |
| 订阅成功 | 按钮变为成功状态 |
| 验证码执行失败 | Alert 显示错误 |

约 4 个测试。

### 5. Register.test.ts 补充

mock `vue-sonner`，新增：

| 测试 | 验证 |
|---|---|
| 注册按钮 loading 状态 | disabled + loading 文本 |
| 复制 token 失败 | `toast.error('复制失败')` |
| 验证码执行失败 | Alert 显示错误 |

约 3 个测试。

### 6. Recover.test.ts 补充

mock `vue-sonner`，新增：

| 测试 | 验证 |
|---|---|
| 找回按钮 loading 状态 | disabled + loading 文本 |
| 非 mismatch 错误 | Alert 显示 parseApiError 结果 |
| 复制 token 失败 | `toast.error('复制失败')` |
| 验证码执行失败 | Alert 显示错误 |

约 4 个测试。

## 涉及文件

| 文件 | 变更 |
|---|---|
| `frontend/src/utils/__tests__/error.test.ts` | 新增 |
| `frontend/src/composables/__tests__/useButtonFeedback.test.ts` | 新增 |
| `frontend/src/views/__tests__/Dashboard.test.ts` | 补充 6 个测试 |
| `frontend/src/views/__tests__/Add.test.ts` | 补充 4 个测试 |
| `frontend/src/views/__tests__/Register.test.ts` | 补充 3 个测试 |
| `frontend/src/views/__tests__/Recover.test.ts` | 补充 4 个测试 |

总计约 35 个新测试。
