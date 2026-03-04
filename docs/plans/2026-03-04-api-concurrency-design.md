# CQU API 并发优化设计

Issue: #26

## 问题

多处 CQU API 调用存在不必要的顺序执行和重复请求，浪费 subrequest 预算和墙钟时间。

## 方案选择

**方案 A（选定）**：KV 短 TTL 缓存去重 + Promise.allSettled 全面并行。不新增 API 端点，前后端独立改进。

排除的方案 B：新增 `refresh-all` 端点。覆盖面不如 KV 缓存（只解决前端批量场景，不解决 queue consumer 和单次 HTTP refresh 的重复问题）。

## 优化点

### 1. fetchPersonalSchedule 并行化

**文件**: `src/services/sync.ts:70-82`

`getSchedule()` 和 `getExams()` 是独立 CQU API 调用，改为 `Promise.all` 并行。

```typescript
const [courses, exams] = await Promise.all([
  api.getSchedule(studentId, ctx.sessionId),
  api.getExams(),
]);
```

预期节省 ~1-5s per sync。

### 2. KV 缓存 fetchPersonalSchedule 结果

**文件**: `src/services/sync.ts`（新增 `fetchPersonalScheduleCached`）

同一用户的多个 personal 订阅共享相同数据。加 KV 短 TTL 缓存避免重复调 CQU API。

- Cache key: `sync:personal:${studentId}`
- TTL: 300s (5 min)
- 调用者改动: `src/routes/subscriptions.ts` refresh 端点、`src/cron/schedule-sync.ts`

### 3. Token Refresh Consumer 并行化

**文件**: `src/cron/token-refresh.ts`

`for` 循环改为 `Promise.allSettled(batch.messages.map(...))`。每条消息独立 try/catch，失败调 `message.retry()`。

### 4. Schedule Sync Consumer 并行化

**文件**: `src/cron/schedule-sync.ts`

- Personal 订阅：先获取数据（一次，带 KV 缓存），然后 `Promise.allSettled` 并行 build+apply
- Explore 订阅：`Promise.allSettled` 全部并行（各自独立 sourceType/sourceId）
- 消息级处理也用 `Promise.allSettled` 并行

### 5. 前端 handleSyncAll 并行化

**文件**: `frontend/src/views/Dashboard.vue`

`for` 循环改为 `Promise.all(personalSubs.map(...))`。配合后端 KV 缓存，并行请求中只有第一个真正调 CQU API。

错误处理：`Promise.all`，任一失败即报错（保持现有 UX）。

## 测试策略

- 在现有测试文件中添加 case
- `fetchPersonalSchedule`: 验证 Promise.all 返回正确
- `fetchPersonalScheduleCached`: mock KV get/put，验证缓存命中/未命中
- token-refresh consumer: 验证并行处理，单条失败不影响其他
- schedule-sync consumer: 验证 personal/explore 并行
- 前端 `handleSyncAll`: 验证并行发送 refresh 请求
