# fix: use correct HTTP status codes for resource creation and deletion

GitHub Issue: #32

## 问题

多个端点的成功状态码不符合 REST 约定：

- `POST /api/v1/users`（新用户）返回 200，应为 201
- `POST /api/v1/subscriptions` 返回 200，应为 201
- `DELETE /api/v1/subscriptions/:sub_token` 返回 200 `{ success: true }`，应为 204 No Content

`POST /api/v1/users` 已有用户场景（更新 token/密码）返回 200 是正确的。
`DELETE /api/v1/users/me` 已经返回 204，无需修改。

## 方案

按 REST 约定修正状态码，前端同步清理。

### 后端修改 (3 处)

| 文件 | 行 | 当前 | 修改为 |
|------|-----|------|--------|
| `src/routes/users.ts` | ~162 | `c.json({ calendar_token }, 200)` | `c.json({ calendar_token }, 201)` |
| `src/routes/subscriptions.ts` | ~175 | `c.json({ ... }, 200)` | `c.json({ ... }, 201)` |
| `src/routes/subscriptions.ts` | ~216 | `c.json({ success: true }, 200)` | `c.body(null, 204)` |

### 前端修改 (1 处)

| 文件 | 改动 |
|------|------|
| `frontend/src/api/index.js` `deleteSubscription()` | 去掉 `return response.data`，与 `deleteUser()` 一致 |

### 影响分析

- 前端组件不依赖这些响应的 status code 或 body（创建/删除后都是重新 GET 刷新列表）
- 错误处理路径不受影响，只改成功路径
- 后端测试需更新期望的状态码

### 测试

- 更新后端测试中相关断言的期望状态码（200 → 201/204）
- 前端测试如有涉及也需同步
