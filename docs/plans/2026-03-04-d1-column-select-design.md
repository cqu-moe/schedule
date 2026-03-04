# D1 列级 Select 优化设计

**Issue**: #27
**日期**: 2026-03-04

## 问题

多处 D1 查询使用 `.select()` 加载全部列。subscriptions 表含 `icsContent`、`coursesJson`、`examsJson` 等大 TEXT 列（单行可达 200KB+），users 表含加密 token 字段。在热路径上浪费 I/O 和带宽。

## 方案

将所有 `.select()` 替换为列级 `.select({ ... })`，只查询实际使用的列。

## Auth 中间件拆分

**当前**: 单一 `requireAuth` → `lookupUser` → `.select()` 全部 11 列

**改为两级中间件**:

- **`requireAuth`**: select `{ id, studentId, calendarToken }` → `c.set('user', LightUser)`
- **`requireAuthWithCquToken`**: select 上述 + `{ accessToken, refreshToken, encryptedPassword, tokenExpiresAt }` → `c.set('user', FullUser)`

使用 Hono Variables 泛型保证类型安全。

需要 `requireAuthWithCquToken` 的路由:
- `POST /subscriptions` (创建订阅)
- `POST /subscriptions/:sub_token/refresh` (刷新订阅)
- `GET /explore/*` (课表搜索)

其余认证路由用 `requireAuth`。

## Subscriptions 表查询优化

| 查询 | 优化后 select |
|------|--------------|
| 订阅数量检查 | `{ id, sourceType, sourceId, sessionId }` |
| 删除订阅查找 | `{ id, isPersonal, calendarToken }` |
| calendar.ics 端点 | `{ icsContent }` |
| getSubForExport | `{ coursesJson, examsJson, semesterStart, sessionName }` |
| 刷新订阅查找 | `{ id, sourceType, sourceId, sessionId, sessionName, isPersonal, semesterStart }` |

## Users 表查询优化

| 查询 | 优化后 select |
|------|--------------|
| 注册检查已有用户 | `{ id, calendarToken }` |
| 密码恢复 | `{ encryptedPassword, calendarToken }` |
| SSO 恢复验证 | `{ id, calendarToken }` |
| schedule-sync consumer | `{ id, studentId, accessToken, refreshToken, encryptedPassword, tokenExpiresAt }` |
| schedule-sync 获取用户订阅 | `{ id, sourceType, sourceId, sessionId, sessionName }` |
| token-refresh consumer | `{ id, studentId, refreshToken, encryptedPassword, tokenExpiresAt }` |

## 测试策略

不新增测试。现有测试已覆盖所有查询路径——列 select 遗漏会导致 `undefined` 访问，现有测试自然失败。验证: typecheck + `npm test` 全量通过。
