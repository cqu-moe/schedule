# Admin Refresh-All: Design

## Problem

修改 ICS 生成逻辑（如调整 VALARM、UID 算法、DESCRIPTION 格式）后，需要让所有订阅的 ICS 内容立即更新。当前只有每天 17:00 的 cron 会触发全量同步，且用 `spreadEnqueue` 分散 6 小时投递，不适合"快速传播"场景。

## Solution

### Admin API 端点

新建 `src/routes/admin.ts`，挂载到 `/api/v1/admin`。

#### `POST /api/v1/admin/refresh-all`

1. 校验 `Authorization: Bearer <ADMIN_SECRET>`，不匹配返回 401
2. 查询所有 `accessToken IS NOT NULL` 的活跃用户
3. 用 `queue.sendBatch()` 直接入队，**不加延迟**（`delaySeconds: 0`），分批 100 条/次
4. 返回 `{ enqueued: number }`

复用现有 `schedule-sync` queue 和 consumer，不新建 queue。

#### Env 变量

`ADMIN_SECRET: string` 加到 `Env` 接口，通过 `wrangler secret put` 设置。

#### 响应格式

| 场景 | 状态码 | 响应 |
|---|---|---|
| 成功入队 | 200 | `{ enqueued: 42 }` |
| 无活跃用户 | 200 | `{ enqueued: 0 }` |
| 缺少/错误 Authorization | 401 | `{ detail: { error: { code: "UNAUTHORIZED", message: "..." } } }` |

#### 不需要额外处理

- Queue 消费失败：已有 `max_retries: 3` 和日志
- 限频：admin 端点不加 rate limit（有 secret 保护）
- 日志：入队时记一条 `{ event: "admin.refresh_all.enqueued", count }`

### Admin Shell 脚本

`scripts/admin-refresh-all.sh`:

```bash
#!/bin/bash
URL="${1:-https://schedule.cqu.moe}"
curl -X POST "$URL/api/v1/admin/refresh-all" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json"
```

- 从环境变量 `ADMIN_SECRET` 读取密钥
- 默认打生产，可传参数覆盖 URL

## Scope

### In scope

- `src/routes/admin.ts` — admin 路由模块（鉴权中间件 + refresh-all 端点）
- `src/types.ts` — `Env` 接口添加 `ADMIN_SECRET`
- `src/index.ts` — 挂载 admin 路由
- `scripts/admin-refresh-all.sh` — 命令行触发脚本
- 测试

### Out of scope

- 前端管理页面
- 其他 admin 端点（未来按需添加）
- 修改现有 cron/queue consumer 逻辑
