# Queue 请求分散设计

## 问题

当前 cron 触发时，所有符合条件的用户一次性入队，queue consumer 以最大并发处理，导致短时间内向 CQU API 发送大量并发请求。

- Token Refresh (每小时): max_concurrency 5 × max_batch_size 20 = 最多 100 条并行，每条 1-5 个 API 调用
- Schedule Sync (每天): max_concurrency 3 × max_batch_size 10 = 最多 30 条并行，每条 5-7+ 个 API 调用

## 方案

结合 Producer 端 `delaySeconds` 分时投递 + 降低 Consumer 并发配置，实现并发控制与时间分散。

### Producer 端 delaySeconds

利用 Cloudflare Queue 原生的 per-message `delaySeconds`（0-43200 秒），在入队时给每条消息附加递增延迟。

**Token Refresh（分散到 1 小时内）：**
- 间隔 = `Math.max(5, Math.floor(3600 / userCount))` 秒
- 50 用户 → 每 72 秒投递一条

**Schedule Sync（分散到 6 小时内）：**
- 间隔 = `Math.max(10, Math.floor(21600 / userCount))` 秒
- 50 用户 → 每 ~7 分钟投递一条

### Consumer 并发配置

| 配置项 | Token Refresh 现值 → 新值 | Schedule Sync 现值 → 新值 |
|---|---|---|
| max_concurrency | 5 → 1 | 3 → 1 |
| max_batch_size | 20 → 5 | 10 → 5 |
| max_batch_timeout | 30 (不变) | 30 (不变) |
| max_retries | 3 (不变) | 3 (不变) |

### Cron 时间调整

- Schedule Sync: `0 19 * * *` → `0 17 * * *` (UTC 17:00 = 北京凌晨 1:00，分散 6 小时到 7:00)
- Token Refresh: `0 * * * *` 不变

## 改动范围

| 文件 | 变更 |
|---|---|
| `src/cron/token-refresh.ts` | producer `sendBatch` 每条消息加 `delaySeconds` |
| `src/cron/schedule-sync.ts` | producer `sendBatch` 每条消息加 `delaySeconds` |
| `wrangler.jsonc` | consumer 并发配置降低；cron 时间调整 |

Consumer 处理逻辑、消息格式、重试机制均不变。

## 效果

最坏情况并发 CQU API 调用数：
- Token Refresh: 1 batch × 5 msg × 5 calls = 25 (之前最高 500)
- Schedule Sync: 1 batch × 5 msg × 7 calls = 35 (之前最高 210)
