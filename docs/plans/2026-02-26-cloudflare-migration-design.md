# CQU 课表订阅服务 — Cloudflare 迁移设计

日期：2026-02-26

## 1. 概述

将 CQU 课表订阅服务从腾讯云 VPS（FastAPI + PostgreSQL + Docker）迁移到 Cloudflare 原生环境，降低成本、简化运维、提升全球性能。

### 迁移范围

- 主服务 API → Cloudflare Workers (Hono)
- 数据库 → Cloudflare D1 (SQLite)
- 前端 → Workers Static Assets
- 定时任务 → Cron Triggers
- 限流 → Workers Rate Limiting binding
- 加密 → Web Crypto API AES-256-GCM
- VPS 仅保留 Playwright 登录服务（最小化）

## 2. 架构总览

```
example.com (Cloudflare DNS)
│
└─ CF Worker (单一部署单元)
    ├─ /api/v1/*        →  Hono API
    ├─ /assets/*        →  Static Assets (Vue 构建产物)
    └─ /*               →  SPA fallback → index.html
    │
    ├─ D1 binding       →  数据库
    ├─ Rate Limit binding → 限流
    └─ Secrets          →  加密密钥、CF Access Token
    │
    └─ fetch() + CF Access Service Token
        ↓
playwright.example.com (Cloudflare Tunnel + Access)
    └─ VPS (Playwright 登录服务，无公网端口)
        ↓
    CQU 教务系统
```

### 技术栈映射

| 原有 (Python) | 新 (TypeScript) |
|---|---|
| FastAPI | Hono + `@hono/zod-openapi` |
| Pydantic | Zod |
| SQLAlchemy + PostgreSQL | Drizzle ORM + CF D1 (SQLite) |
| slowapi | CF Rate Limiting binding |
| Fernet (cryptography) | Web Crypto AES-256-GCM |
| httpx | fetch() (原生) |
| APScheduler | Cron Triggers |
| Docker + VPS | CF Workers (无服务器) |
| 前端打包到 static/ | Workers Static Assets |

## 3. 数据库设计 (D1 + Drizzle ORM)

### PostgreSQL → SQLite 类型映射

| PostgreSQL | D1 (SQLite) |
|---|---|
| `SERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `JSONB` | `TEXT` + `json_extract()` |
| `TIMESTAMP WITH TIME ZONE` | `TEXT` (ISO 8601) |
| `BOOLEAN` | `INTEGER` (0/1) |
| `VARCHAR(n)` | `TEXT` |

### Schema (Drizzle ORM)

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  studentId: text('student_id').notNull().unique(),
  encryptedPassword: text('encrypted_password').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: text('token_expires_at'),
  calendarToken: text('calendar_token').notNull().unique(),
  lastLogin: text('last_login'),
  lastRefresh: text('last_refresh'),
  createdAt: text('created_at').notNull(),
})

export const subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull(),
  sessionId: text('session_id'),
  semesterId: text('semester_id'),
  sourceParams: text('source_params'),
  coursesJson: text('courses_json'),
  examsJson: text('exams_json'),
  icsContent: text('ics_content'),
  lastUpdated: text('last_updated'),
  createdAt: text('created_at').notNull(),
})
```

### ICS 缓存策略

ICS 缓存直接存在 D1 的 `ics_content` 列中（单行最大 2MB，足够）。不引入 KV，保持单一数据源，简化一致性管理。后期如需优化可迁移至 KV。

### 加密方案

```
Fernet (Python) → AES-256-GCM (Web Crypto API)

存储格式: base64(IV[12字节] + ciphertext + authTag)
密钥: 256-bit，存为 Workers Secret
```

数据迁移时需要：旧 Fernet 密钥解密 → 新 AES-256-GCM 密钥重新加密 → 写入 D1。

## 4. API 层设计 (Hono + Zod)

### 路由映射（完全兼容现有前端）

```
POST /api/v1/users/register
POST /api/v1/users/login
POST /api/v1/users/recover/verify
POST /api/v1/users/recover/refresh
DELETE /api/v1/users/me

POST /api/v1/subscriptions
GET  /api/v1/subscriptions
DELETE /api/v1/subscriptions/:sub_token
POST /api/v1/subscriptions/:sub_token/refresh
GET  /api/v1/subscriptions/:sub_token/calendar.ics
GET  /api/v1/subscriptions/:sub_token/origin.json
GET  /api/v1/subscriptions/:sub_token/data.json
GET  /api/v1/subscriptions/:sub_token/data.csv

GET  /api/v1/search
GET  /api/v1/departments

POST /api/v1/captcha/config
GET  /api/v1/config
GET  /api/v1/health
```

### 项目结构

```
src/
├── index.ts                 # 入口：Hono app + scheduled handler
├── routes/
│   ├── users.ts             # 用户注册/登录/恢复
│   ├── subscriptions.ts     # 订阅 CRUD + 导出
│   ├── explore.ts           # 搜索 + 订阅
│   ├── captcha.ts           # hCaptcha 验证
│   └── config.ts            # 配置 + 健康检查
├── middleware/
│   ├── auth.ts              # Bearer token 认证
│   └── rateLimit.ts         # Rate Limiting 包装
├── db/
│   ├── schema.ts            # Drizzle ORM schema
│   └── migrations/          # Drizzle Kit 生成
├── services/
│   ├── crypto.ts            # AES-256-GCM 加解密
│   ├── ics.ts               # ICS 日历生成
│   ├── export.ts            # JSON/CSV 导出
│   ├── worker-client.ts     # 调用 VPS Playwright 服务
│   └── cqu-api.ts           # CQU API 数据结构
├── cron/
│   ├── token-refresh.ts     # Token 刷新逻辑
│   └── schedule-sync.ts     # 课表同步逻辑
└── types.ts                 # Env 接口 + 共享类型
```

### 认证方案

- 用户 API：Bearer `calendar_token`（64 字符）
- ICS/导出端点：URL 中的 `calendar_token` 参数（日历客户端不支持 Header）
- VPS 通信：Cloudflare Access Service Token

### Rate Limiting

```jsonc
{
  "ratelimits": [
    { "name": "UNAUTH_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
    { "name": "AUTH_LIMITER", "namespace_id": "1002", "simple": { "limit": 20, "period": 60 } },
    { "name": "EXPLORE_LIMITER", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } }
  ]
}
```

Rate Limiting binding 无额外计费，包含在 Workers 计划中。限流为 per-location（按边缘节点），最终一致。

## 5. 定时任务 (Cron Triggers)

```jsonc
{
  "triggers": {
    "crons": [
      "0 */3 * * *",   // 每 3 小时：Token 刷新
      "0 19 * * *"     // UTC 19:00 = 北京时间 03:00：课表同步
    ]
  }
}
```

百级用户规模下，单个 Cron Trigger 直接循环处理所有用户即可，不需要引入 Queues。付费计划 Cron Trigger 有 15 分钟 CPU 时间限制，网络 I/O 等待不计入 CPU 时间。

### Token 刷新流程

```
Cron → 查 D1 即将过期的 token → 逐个调用 VPS refresh → 更新 D1
```

### 课表同步流程

```
Cron → 遍历所有订阅 → CF Worker 直接调 CQU API → 重新生成 ICS → 更新 D1
```

CQU API 海外可访问，课表获取、部门查询等纯 HTTP 请求由 CF Worker 直接发起。

## 6. VPS 登录服务（最小化保留）

### 保留范围

| 原有 Worker 端点 | 保留/移除 | 原因 |
|---|---|---|
| POST /api/auth/login | 保留 | 需要 Playwright |
| POST /api/auth/refresh | 保留 | 需要 Playwright |
| GET /api/schedule/* | 移除 | CF Worker 直接调 CQU API |
| GET /api/departments | 移除 | CF Worker 直接调 CQU API |
| GET /api/health | 保留 | 健康检查 |

VPS 可降配至最低配置（~512MB 内存即可运行 Playwright）。

### 通信安全：Cloudflare Tunnel + Access Service Token

```
CF Worker → fetch() + Service Token Headers → Cloudflare 网络
  → Access 策略验证 → cloudflared tunnel → VPS (localhost)
```

- VPS 无公网端口暴露，cloudflared 反向连接
- Cloudflare Access 签发 Service Token（CF-Access-Client-Id + CF-Access-Client-Secret）
- Access 策略仅允许该 Service Token 访问
- 自带 DDoS 防护和审计日志

## 7. 部署架构

### Workers 统一入口 + Static Assets

```jsonc
// wrangler.jsonc
{
  "name": "schedule",
  "main": "src/index.ts",
  "compatibility_date": "2026-02-26",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./frontend/dist",
    "not_found_handling": "single-page-application"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "schedule-db",
    "database_id": "<id>"
  }],
  "ratelimits": [
    { "name": "UNAUTH_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } },
    { "name": "AUTH_LIMITER", "namespace_id": "1002", "simple": { "limit": 20, "period": 60 } },
    { "name": "EXPLORE_LIMITER", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } }
  ],
  "triggers": {
    "crons": ["0 */3 * * *", "0 19 * * *"]
  }
}
```

### CI/CD

- `wrangler deploy` 一次部署前端 + 后端
- GitHub Actions 触发（push to main）
- VPS Playwright 服务保持现有 Docker + deploy.sh

## 8. 成本预估

### 免费计划 ($0/月) — 预计可覆盖

| 服务 | 免费额度 | 预估用量 |
|---|---|---|
| Workers | 10万请求/天 | <1万/天 |
| D1 | 500万读/天, 10万写/天, 500MB | 充裕 |
| Cron Triggers | 5 个 | 需要 2 个 |
| Rate Limiting | 包含 | — |
| Static Assets | 无限 | — |

### 付费计划 ($5/月) — 如需更多资源

| 服务 | 付费额度 |
|---|---|
| Workers | 1000万请求/月, 30M CPU ms |
| D1 | 250亿读/月, 5000万写/月, 5GB |
| Cron Triggers | 250 个, 15分钟 CPU |

VPS 降配至最低配置，仅运行 Playwright。

## 9. 迁移执行顺序

### 阶段 1: 基础设施准备

- 创建 D1 数据库、Workers 项目
- 配置 cloudflared tunnel + Access Service Token
- 配置自定义域名路由

### 阶段 2: 核心 API 迁移

- 实现 Hono 路由 + Drizzle schema + 迁移
- 实现加密模块 (AES-256-GCM)
- 实现 VPS 通信 (fetch + Access Service Token)

### 阶段 3: 功能补全

- ICS 生成、JSON/CSV 导出
- hCaptcha 验证
- Rate Limiting
- 前端集成（Static Assets）

### 阶段 4: 定时任务

- Cron Triggers: token 刷新 + 课表同步

### 阶段 5: 数据迁移 + 切换

- PostgreSQL → D1 数据导入（密码重新加密 Fernet → AES-256-GCM）
- DNS 切换到 CF
- 验证全部功能
- VPS 降配，仅保留 Playwright

## 10. 关键风险与缓解

| 风险 | 缓解措施 |
|---|---|
| D1 SQLite 与 PostgreSQL 行为差异 | 充分测试，利用 Drizzle 抽象层 |
| 加密方案变更导致数据丢失 | 迁移前备份，编写双向迁移脚本 |
| Cron Trigger 超时（用户增长后） | 监控执行时间，必要时引入 Queues |
| VPS 登录服务不可用 | 健康检查 + 告警，不影响已有订阅的 ICS 读取 |
| D1 免费额度不足 | 监控用量，升级至 $5/月付费计划 |
