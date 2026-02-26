# CQU Schedule - Cloudflare Workers

## 项目概述
CQU 课表订阅服务。Cloudflare Workers + D1，从 FastAPI + PostgreSQL 迁移而来。
原项目: `/Users/uu/Documents/Coding/cqu-moe/schedule`

## 技术栈
- Runtime: Cloudflare Workers (Hono framework)
- Database: D1 (SQLite) via Drizzle ORM
- Crypto: Web Crypto API AES-256-GCM (`src/services/crypto.ts`), node:crypto AES-ECB (`src/services/auth.ts`)
- Auth: 纯 HTTP CAS→OAuth 登录流程 (`src/services/auth.ts`), 无需浏览器
- Frontend: Vue 3 + Tailwind v4 + shadcn-vue (in `frontend/`)

## 常用命令
- `npm run dev` — 启动 wrangler dev server (port 8787)
- `npm run dev:frontend` — 启动前端 vite dev server (port 5173, proxy -> 8787)
- `npm run build:frontend` — 构建前端到 frontend/dist
- `npm run deploy` — 先构建前端再 wrangler deploy
- `npm test` — vitest run (workerd runtime)
- `npm run typecheck` — tsc --noEmit
- `npm run db:generate` — drizzle-kit generate migrations
- `npm run db:migrate:local` — apply D1 migrations locally

## 开发注意事项
- vitest 必须用 v3 (v4 与 @cloudflare/vitest-pool-workers 不兼容)
- vitest.config.ts 中 miniflare.compatibilityDate 设为 "2025-01-01" (规避 future date 错误)
- wrangler.jsonc 中 database_id/namespace_id 是 placeholder，部署前需替换真实值
- frontend/dist 和 frontend/node_modules 已 gitignore
- 错误响应格式: `{ detail: { error: { code, message } } }` 或 `{ detail: "string" }`
- Hono 路由：静态路径 (如 /recover) 必须定义在参数路径 (如 /:token) 之前
- `run_worker_first: true` 确保 /api/* 请求先到 Worker 再到静态资源

## 项目结构
- `src/index.ts` — 入口 (Hono app, CORS, routes, cron)
- `src/types.ts` — Env 接口定义
- `src/db/schema.ts` — Drizzle ORM 表定义 (users, subscriptions)
- `src/services/` — 核心服务 (crypto, cqu-api, ics, export, auth, captcha)
- `src/middleware/` — 中间件 (auth, rate-limit)
- `src/routes/` — API 路由 (config, users, subscriptions, explore)
- `src/cron/` — 定时任务 (token-refresh, schedule-sync)
- `src/utils/token.ts` — 共享 token 生成函数
- `frontend/` — Vue 前端 (独立 npm 项目)
- `docs/plans/` — 设计文档和实现计划
