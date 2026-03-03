# CQU Schedule - Cloudflare Workers

## 项目概述
CQU 课表订阅服务。Cloudflare Workers + D1，从 FastAPI + PostgreSQL 迁移而来。
GitHub: https://github.com/cqu-moe/schedule-cloudflare (Private)
部署: https://schedule.cqu.moe (worker: schedule-beta-cqu-moe, 同时绑定 schedule-beta.cqu.moe)
原项目: `/Users/uu/Documents/Coding/cqu-moe/schedule`

## 技术栈
- Runtime: Cloudflare Workers (Hono framework)
- Database: D1 (SQLite) via Drizzle ORM
- Crypto: Web Crypto API AES-256-GCM (`src/services/crypto.ts`), node:crypto AES-ECB (`src/services/auth.ts`)
- Auth: 纯 HTTP CAS→OAuth 登录流程 (`src/services/auth.ts`), 无需浏览器
- Frontend: Vue 3 + Tailwind v4 + shadcn-vue (in `frontend/`)
- Cache: KV namespace `CACHE` 缓存 SessionContext (24h TTL)，减少 CQU API 调用
- Queues: `schedule-token-refresh` (token 刷新) + `schedule-sync` (课表同步), cron 入队 + consumer 处理
- Placement: `hostname: "my.cqu.edu.cn"` 将 Worker 放在离 CQU API 最近的数据中心

## 常用命令
- `npm run dev` — 启动 wrangler dev server (port 8787)
- `npm run dev:frontend` — 启动前端 vite dev server (port 5173, proxy -> 8787)
- `npm run build:frontend` — 构建前端到 frontend/dist
- `npm run deploy` — 构建前端 + wrangler deploy (自动注入 GIT_COMMIT/GIT_DATE)
- `npm test` — vitest run (workerd runtime)
- `npm run test:frontend` — 前端 vitest run (jsdom, cd frontend && npm test)
- `npm run typecheck` — tsc --noEmit
- `npm run db:generate` — drizzle-kit generate migrations
- `npm run db:migrate:local` — apply D1 migrations locally
- `npm run setup:secrets` — 从 1Password 生成 .dev.vars (op inject)
- `npm run deploy:secrets` — 从 1Password 推送 secrets 到 Cloudflare (op read → wrangler secret put)
- `npx wrangler d1 execute schedule-beta-cqu-moe-db --remote --command "SQL"` — 查询生产 D1
- `npx wrangler tail schedule-beta-cqu-moe --format pretty` — 实时查看生产 Worker 日志
- `npx wrangler dev --remote --test-scheduled` — 用生产 D1 手动触发 cron (访问 `http://localhost:8787/__scheduled?cron=<url-encoded-cron>`)

## 开发注意事项
- 后端 vitest 必须用 v3 (v4 与 @cloudflare/vitest-pool-workers 不兼容)；前端独立 npm 项目用 vitest v4 + jsdom
- vitest.config.ts 中 miniflare.compatibilityDate 设为 "2025-01-01" (规避 future date 错误)
- wrangler.jsonc 中 database_id/namespace_id 是 placeholder，部署前需替换真实值
- frontend/dist 和 frontend/node_modules 已 gitignore
- Git worktree 中 `frontend/dist` 不存在（gitignore），需 `mkdir -p frontend/dist` 后才能运行后端测试
- `npm test` 会同时跑前端测试，worktree 中前端 node_modules 缺失会导致失败；只跑后端测试需显式指定文件: `npm test -- src/services/crypto.test.ts src/routes/users.test.ts ...`
- 错误响应格式: `{ detail: { error: { code, message } } }` 或 `{ detail: "string" }`
- Hono 路由：静态路径 (如 /recover) 必须定义在参数路径 (如 /:token) 之前
- `run_worker_first: true` 确保 /api/* 请求先到 Worker 再到静态资源
- workerd 中 `createCipheriv` 不接受 `null` 作为 IV，ECB 模式须传 `""` (空字符串)
- `node:crypto` 需要 `nodejs_compat` flag 和 `@types/node` devDep + tsconfig types
- CQU SSO/jwxt 逆向文档: `../cqu-api-endpoint-collection/systems/auth/` 和 `../cqu-api-endpoint-collection/systems/jwxt/`
- CQU SSO `captchaId` 始终存在于登录页 HTML 中，不代表需要验证码；须调用 `findCaptchaCount` API 判断
- Workers fetch 默认 UA 会被 SSO 识别为机器人，login 请求须带浏览器 User-Agent
- Cloudflare Builds 只在根目录 `npm ci`，前端依赖需在 `build:frontend` 中 `npm install`
- Cloudflare Builds deploy command 须设为 `npm run deploy` (非 `npx wrangler deploy`)
- `git log --format` 中 `%d` 是 ref names 不是日期；获取日期用 `--format=%cd --date=short`
- `wrangler dev --remote` 的 console.log 不显示在本地终端（代码在 edge 执行），调试需配合 `wrangler tail`
- `npm run setup:secrets` 需要 1Password 桌面应用已打开并解锁
- D1 SQL 查询须用 snake_case 列名 (如 `student_id`)，非 Drizzle 的 camelCase (如 `studentId`)
- 有 Cloudflare Builds 自动部署，push 到 main 即触发，一般不需手动 `npm run deploy`
- CQU OAuth token 有效期约 4 小时，token-refresh cron 每小时运行 (`0 * * * *`)，2 小时 lookahead
- Workers placement 只影响 fetch handler，不影响 cron scheduled handler
- Cron handler 只做入队 (`sendBatch`)，实际处理在 Queue consumer 中
- `sendBatch` 最多 100 条/次，>100 用户需分批调用
- Queue consumer 有独立的 subrequest (1000) 和墙钟 (15min) 限制
- `cloudflare:test` 模块类型仅在 vitest pool workers 中可用，tsconfig.json 须 exclude `src/**/*.test.ts`
- Queue handler 的 `MessageBatch` 默认泛型为 `unknown`，须用 `batch as MessageBatch<T>` 类型断言
- 前端测试: `frontend/src/test-utils.ts` 提供 `mountWithContext()` helper (Pinia + Router + 默认 stubs)
- 前端测试: shadcn-vue teleporting 组件 (AlertDialog, Dialog, DropdownMenu 等) 需在 test-setup.ts 全局 stub
- 前端测试: `@pinia/testing` 须用 v0.1.x (v1.x 需要 pinia>=3，当前项目用 pinia v2)
- 前端测试: vitest v4 中 `vi.mock()` factory 被 hoist，mock 对象须用 `vi.hoisted()` 声明

## 前端开发注意事项
- 前端测试运行: `npm run test:frontend`（cd frontend && npm test），构建验证: `cd frontend && npm run build`
- `vue-tsc --noEmit` 有预存的 tsconfig.node.json 错误，不影响构建
- Toast 通知用 vue-sonner（`<Toaster />` 在 App.vue），错误解析用 `frontend/src/utils/error.ts` 的 `parseApiError()`
- 表单错误用 shadcn-vue Alert 内联组件，后台操作用 Toast
- Captcha 配置加载失败应静默降级（captcha 可选），不要弹 toast 报错
- Mutation 成功后调用 loadSubscriptions() 刷新列表时，成功 toast 须在 loadSubscriptions() 之前发出，reload 用 `.catch(() => {})` 忽略失败
- 429 限频由 axios interceptor (`frontend/src/api/index.js`) 统一转为 `{ detail: "操作过于频繁，请稍后再试" }`，`parseApiError` 自动处理

## 项目结构
- `src/index.ts` — 入口 (Hono app, CORS, routes, cron, queue handler)
- `src/types.ts` — Env 接口定义
- `src/db/schema.ts` — Drizzle ORM 表定义 (users, subscriptions)
- `src/services/` — 核心服务 (crypto, cqu-api, ics, export, auth, captcha, sync)
- `src/middleware/` — 中间件 (auth, rate-limit)
- `src/routes/` — API 路由 (config, users, subscriptions, explore)
- `src/cron/` — 定时任务 producer + queue consumer (token-refresh, schedule-sync)
- `src/utils/` — 共享工具 (token.ts: token 生成, time.ts: 中国时区格式化)
- `frontend/` — Vue 前端 (独立 npm 项目)
- `frontend/vitest.config.ts` — 前端测试配置 (jsdom, @/ alias)
- `frontend/src/test-setup.ts` — 全局 mock (clipboard, hCaptcha, shadcn stubs)
- `frontend/src/test-utils.ts` — 测试工具 (mock factories, mountWithContext)
- `docs/plans/` — 设计文档和实现计划
- OAuth token (accessToken/refreshToken) 使用 AES-256-GCM 加密存储，读写路径:
  - 写入: `src/routes/users.ts` (注册+恢复), `src/cron/token-refresh.ts` (刷新+重登录)
  - 读取: `src/routes/subscriptions.ts`, `src/routes/explore.ts`, `src/cron/schedule-sync.ts`, `src/cron/token-refresh.ts`
  - TODO(#13): `decryptOrPlaintext()` 明文兼容函数待清理
