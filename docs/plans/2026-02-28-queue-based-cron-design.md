# Queue-Based Cron 设计

## 问题

Workers scheduled handler 有硬限制：
- Subrequest 上限：1000 次/invocation
- 墙钟时间：15 分钟

当前 cron 在一次 invocation 中顺序处理所有用户。按 1000 用户规模：
- Token refresh 最坏情况：1000 × 6 = 6000 subrequests（超限 6 倍）
- Schedule sync：1000 × 4 = 4000+ subrequests（超限 4 倍）
- 墙钟时间：1000 × 5-10s = 83-167 分钟（超限 5-11 倍）

## 方案

用 Cloudflare Queues 将 cron 拆为 producer + consumer：

```
Cron trigger → 查询 D1 → sendBatch 到 Queue（每用户一条消息）
                                    ↓
                          Queue consumer 批量消费（每批独立限制）
```

### 为什么选 Queues

| 方案 | 优势 | 劣势 |
|---|---|---|
| **Queues（选定）** | 内建重试、独立限制、低成本 | 多一个基础设施 |
| Durable Objects + Alarms | 完美隔离 | 过于复杂 |
| 链式自调用 | 零新依赖 | 无重试、链条脆弱 |

### Queue 结构

两个独立 Queue（频率和处理逻辑不同）：
- `schedule-token-refresh` — 每小时，处理 token 快过期的用户
- `schedule-sync` — 每天，同步所有活跃用户课表

### 消息格式

```typescript
interface QueueMessage {
  userId: string;
  studentId: string;  // 日志用
}
```

消息只携带标识，consumer 从 D1 读取完整数据。避免敏感数据进入 Queue。

### Consumer 配置

| 参数 | token-refresh | schedule-sync |
|---|---|---|
| `max_batch_size` | 20 | 10 |
| `max_retries` | 3 | 3 |
| `max_concurrency` | 5 | 3 |
| `max_batch_timeout` | 30s | 30s |

token-refresh batch 更大（best case 1 subrequest/用户），schedule-sync 更小（4+ subrequests/用户）。

### Producer 逻辑

```
token-refresh cron (0 * * * *):
  查询 D1: tokenExpiresAt < now + 2h → sendBatch 到 Queue

schedule-sync cron (0 19 * * *):
  查询 D1: 所有有 accessToken 的用户 → sendBatch 到 Queue
```

Cron handler 变为极轻量操作（D1 查询 + Queue 写入）。

### Consumer 逻辑

```
token-refresh consumer:
  for each message:
    从 D1 读取用户最新数据
    检查 tokenExpiresAt 是否仍需刷新（防重复）
    refreshToken() → 成功更新 D1
    失败且 TOKEN_EXPIRED → login() fallback
    业务错误（INVALID_CREDENTIALS）→ ack，记录 loginError
    其他失败 → retry

schedule-sync consumer:
  for each message:
    从 D1 读取用户 + 订阅列表
    fetchSessionContextCached() 共享 KV 缓存
    复用 syncUserSubscriptions() 逻辑
    失败 → retry
```

### 边界情况

- **重复消息**：consumer 检查是否仍需处理，已完成则 ack 跳过
- **部分成功**：每条消息单独 ack/retry
- **CQU API 不可用**：重试 3 次后丢弃，loginError 已记录，下次 cron 重新入队
- **用户被删除**：consumer 发现不存在则 ack 跳过
- **不需要 DLQ**：重试耗尽后 cron 自然重新入队

## 代码变更

### 配置

`wrangler.jsonc` 新增 queues：

```jsonc
"queues": {
  "producers": [
    { "binding": "TOKEN_REFRESH_QUEUE", "queue": "schedule-token-refresh" },
    { "binding": "SCHEDULE_SYNC_QUEUE", "queue": "schedule-sync" }
  ],
  "consumers": [
    {
      "queue": "schedule-token-refresh",
      "max_batch_size": 20,
      "max_retries": 3,
      "max_concurrency": 5,
      "max_batch_timeout": 30
    },
    {
      "queue": "schedule-sync",
      "max_batch_size": 10,
      "max_retries": 3,
      "max_concurrency": 3,
      "max_batch_timeout": 30
    }
  ]
}
```

`src/types.ts` Env 新增 `TOKEN_REFRESH_QUEUE: Queue` 和 `SCHEDULE_SYNC_QUEUE: Queue`。

### 文件变更

| 文件 | 变更 |
|---|---|
| `wrangler.jsonc` | 新增 queues 配置 |
| `src/types.ts` | Env 新增 2 个 Queue binding |
| `src/index.ts` | 新增 queue export，cron 改为入队 |
| `src/cron/token-refresh.ts` | 拆为 producer + consumer |
| `src/cron/schedule-sync.ts` | 拆为 producer + consumer |

### Entry point

```typescript
export default {
  fetch(request, env, ctx) { /* 不变 */ },
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case "0 * * * *":
        await enqueueTokenRefresh(env);
        break;
      case "0 19 * * *":
        await enqueueScheduleSync(env);
        break;
    }
  },
  async queue(batch, env) {
    switch (batch.queue) {
      case "schedule-token-refresh":
        await processTokenRefreshBatch(batch, env);
        break;
      case "schedule-sync":
        await processScheduleSyncBatch(batch, env);
        break;
    }
  },
};
```

## 成本估算

1000 用户 × (24 refresh + 1 sync)/天 = 25,000 消息/天 ≈ 75 万/月。
Queues 定价 $0.40/百万操作 → ~$0.30/月。
