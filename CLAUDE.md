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

### Workers Runtime & Hono
- workerd 中 `createCipheriv` 不接受 `null` 作为 IV，ECB 模式须传 `""` (空字符串)
- `node:crypto` 需要 `nodejs_compat` flag 和 `@types/node` devDep + tsconfig types
- `response.headers.getSetCookie()` 在 Workers runtime 可用但 `@cloudflare/workers-types` 默认不含类型声明，已在 `src/types/headers.d.ts` 补充
- Workers fetch 默认 UA 会被 SSO 识别为机器人，login 请求须带浏览器 User-Agent
- Workers placement 只影响 fetch handler，不影响 cron scheduled handler
- `run_worker_first: true` 确保 /api/* 请求先到 Worker 再到静态资源
- Hono 路由：静态路径 (如 /recover) 必须定义在参数路径 (如 /:token) 之前
- Hono Context 类型不协变：接受 `c` 参数的 helper 函数须匹配 app 的完整 env 类型（如 `AuthEnv`），不能用更窄的 `{ Bindings: Env }`
- 日志格式: `console.log(JSON.stringify({ event: "context.subsystem.action", message: "...", ...fields }))` — 结构化 JSON，便于 Workers Observability 过滤
- Secret/token 比较须用 `crypto.subtle.timingSafeEqual`（防 timing attack），且先检查 `!secret` 防止 `Bearer undefined` bypass

### Cron & Queue
- Cron 表达式在两处定义，修改时必须同步：`wrangler.jsonc` triggers.crons + `src/index.ts` switch case
- Cron handler 只做入队 (`sendBatch`)，实际处理在 Queue consumer 中
- `sendBatch` 最多 100 条/次，>100 用户需分批调用；支持 per-message `delaySeconds`（0-43200 秒）分散投递
- Queue consumer 有独立的 subrequest (1000) 和墙钟 (15min) 限制
- Queue handler 的 `MessageBatch` 默认泛型为 `unknown`，须用 `batch as MessageBatch<T>` 类型断言
- CQU OAuth token 有效期约 4 小时，token-refresh cron 每小时运行 (`0 * * * *`)，2 小时 lookahead

### D1 & Drizzle
- **部署后必须手动执行 D1 migration**: `npx wrangler d1 migrations apply schedule-beta-cqu-moe-db --remote`；`npm run deploy` 只部署代码，不会自动跑 migration，schema drift 会导致运行时错误
- Drizzle `.returning()` 不带参数时生成包含 schema 所有列的 RETURNING 子句；若 DB 缺少列会报 `no such column` 错误（schema drift 的典型症状）
- D1 SQL 查询须用 snake_case 列名 (如 `student_id`)，非 Drizzle 的 camelCase (如 `studentId`)
- Drizzle `sql<number>` 是纯 TypeScript 类型断言，不做运行时类型转换；对 D1 返回值用 `?.` 防御
- wrangler.jsonc 中 database_id/namespace_id 是 placeholder，部署前需替换真实值

### CQU API
- CQU API 的 `roomName` 和 `position` 字段语义不固定：`roomName` 可能是课程名（如"杨氏弹性模量的测量"），`position` 可能是教室编号（如"DS1417"）；`parseCourses()` 用 `ROOM_CODE_REGEX` (`/^[A-E][A-Z\d主理研二]\d/`) 智能选取教室编号，不匹配时 `console.warn` 记录
- CQU SSO/jwxt 逆向文档: `../cqu-api-endpoint-collection/systems/auth/` 和 `../cqu-api-endpoint-collection/systems/jwxt/`
- `CQUAPIClient.request<T>()` 是泛型方法，CQU API 响应接口定义在 cqu-api.ts 内部（不导出），只覆盖代码实际访问的字段
- CQU SSO `captchaId` 始终存在于登录页 HTML 中，不代表需要验证码；须调用 `findCaptchaCount` API 判断

### API 设计
- 错误响应格式: 统一为 `{ detail: { error: { code, message } } }`，使用 `errorResponse(code, message, status)` (from `src/utils/error.ts`)
- CaptchaError.message 就是 error code 字符串 (如 "CAPTCHA_REQUIRED")，`errorResponse(e.message, e.message, 403)`
- ICS `UID` 字段决定日历客户端的事件追踪，修改 UID 生成算法会导致所有订阅者事件重复/丢失自定义
- 移除 API 端点时应保留兼容端点至少一个版本，避免浏览器缓存的旧前端 404

### 测试
- 后端 vitest 必须用 v3 (v4 与 @cloudflare/vitest-pool-workers 不兼容)；前端独立 npm 项目用 vitest v4 + jsdom
- vitest.config.ts 中 miniflare.compatibilityDate 设为 "2025-01-01" (规避 future date 错误)
- `npm test` (vitest run) 会拾取 frontend/ 下的测试文件，但 workerd pool 无法解析 `@/` alias 导致失败；只跑后端测试用 `npx vitest run --exclude 'frontend/**'`（`npx vitest run src/` 仍会拾取 frontend 测试）
- `cloudflare:test` 模块类型仅在 vitest pool workers 中可用，tsconfig.json 须 exclude `src/**/*.test.ts`
- 前端测试: `frontend/src/test-utils.ts` 提供 `mountWithContext()` helper (Pinia + Router + 默认 stubs)
- 前端测试: shadcn-vue teleporting 组件 (AlertDialog, Dialog, DropdownMenu 等) 需在 test-setup.ts 全局 stub
- 前端测试: shadcn-vue DropdownMenuItem 在 stub 下渲染为 `div`（非 `button`），用 `wrapper.findAll('div').filter(...)` 查找；全局 AlertDialog 需两步：先触发 menu item 打开 dialog，再触发 action button
- 前端测试: `@pinia/testing` 须用 v0.1.x (v1.x 需要 pinia>=3，当前项目用 pinia v2)
- 前端测试: vitest v4 中 `vi.mock()` factory 被 hoist，mock 对象须用 `vi.hoisted()` 声明
- Drizzle D1 mock 须同时提供 `all()` 和 `raw()` 方法：`prepare().mockReturnValue({ bind: fn().mockReturnThis(), all: fn(), raw: fn() })`

### 部署 & CI
- Cloudflare Builds 只在根目录 `npm ci`，前端依赖需在 `build:frontend` 中 `npm install`
- Cloudflare Builds deploy command 须设为 `npm run deploy` (非 `npx wrangler deploy`)
- 有 Cloudflare Builds 自动部署，push 到 main 即触发，一般不需手动 `npm run deploy`
- `wrangler dev --remote` 的 console.log 不显示在本地终端（代码在 edge 执行），调试需配合 `wrangler tail`
- `npm run setup:secrets` 需要 1Password 桌面应用已打开并解锁
- CSP 安全头定义在 `src/middleware/security-headers.ts`；添加使用 `data:` URL 内联字体的库时，须在 `font-src` 加 `data:`（如 FullCalendar 的 fcicons）

### Git & 工作流
- frontend/dist 和 frontend/node_modules 已 gitignore
- 项目本地 worktree 目录: `.worktrees/`（已 gitignore）
- Git worktree 中 `frontend/dist` 不存在（gitignore），需 `mkdir -p frontend/dist` 后才能运行后端测试
- Git worktree 中 `.dev.vars` 不存在（gitignore），需从主仓库 `cp .dev.vars .worktrees/<name>/.dev.vars` 后才能运行 `npm run dev`
- 离线后端开发（本地 `wrangler dev` 无 AUTH service binding）需在 `.dev.vars` 中设置 `DEV_AUTH_MOCK=1` 才会注入 mock 用户；未设置时任何 hostname（含 localhost）都 fail-closed 500（issue #86）
- Git commit 签名依赖 1Password SSH agent；若 1Password 未解锁会报 "failed to fill whole buffer"，此时用 `-c commit.gpgsign=false` 暂时跳过，待 1Password 可用后用 `git rebase --exec 'git commit --amend --no-edit -S' HEAD~N` 补签
- 用户要求"创建 PR"时：先 `git checkout -b fix/xxx`，commit 后 `gh pr create`，不要用 `/ship`（ship 直接推 main）

## 前端开发注意事项
- 所有自定义 Vue SFC 已迁移到 `<script setup lang="ts">` (PR #62)，新建组件须保持一致
- `<script setup>` 不支持 ES module exports（编译后在 setup() 内部），需要导出的纯函数应放在独立 `.ts` 文件中
- 前端测试运行: `npm run test:frontend`（cd frontend && npm test），构建验证: `cd frontend && npm run build`
- `vue-tsc --noEmit` 有预存的 tsconfig.node.json 错误，不影响构建
- Toast 通知用 vue-sonner（`<Toaster />` 在 App.vue），错误解析用 `frontend/src/utils/error.ts` 的 `parseApiError()`
- 表单错误用 shadcn-vue Alert 内联组件，后台操作用 Toast
- Captcha 配置加载失败应静默降级（captcha 可选），不要弹 toast 报错
- Mutation 成功后调用 loadSubscriptions() 刷新列表时，成功 toast 须在 loadSubscriptions() 之前发出，reload 用 `.catch(() => {})` 忽略失败
- 429 限频由 axios interceptor (`frontend/src/api/index.ts`) 统一转为 `{ detail: "操作过于频繁，请稍后再试" }`，`parseApiError` 自动处理
- 前端 API 类型定义: `frontend/src/types/api.ts` (UserInfo, Subscription, SearchResult 等)
- 路由名称常量: `RouteNames` 从 `@/router` 导出，用于 `router.push({ name: RouteNames.Dashboard })`
- Pinia Composition API store 不自带 `$reset()`，需手动实现（Options API 自带）
- `vi.hoisted()` 回调中不能 import 其他模块，mock API 对象须内联 `vi.fn()` 创建
- Bundle 分析: `ANALYZE=true npm run build:frontend` 生成 `frontend/dist/stats.html`
- Vite manualChunks: vendor (vue/router/pinia/axios) + ui (reka-ui/lucide/cva/clsx/tailwind-merge)，其余依赖走 Vite 默认分割
- `rollup-plugin-visualizer` 用动态 import + `process.env.ANALYZE` 门控，不影响正常构建
- FullCalendar 主题样式在 `frontend/src/assets/fullcalendar-theme.css`；`.fc { font-family: inherit }` 会覆盖图标字体，须用 `.fc .fc-icon { font-family: fcicons !important }` 恢复
- FullCalendar timegrid 事件的 `::after` 伪元素有 `rgba(0,0,0,0.25)` 遮罩，已用 `.fc .fc-event::after { display: none !important }` 全局禁用
- FullCalendar 命名时区 (`timeZone: 'Asia/Chongqing'`) 下 `event.start` 的 Date 对象将墙钟时间存在 UTC 槽位（`getUTCHours()` 返回中国时间），格式化时须用 `timeZone: 'UTC'`；而数据库 ISO 字符串是真 UTC，格式化须用 `timeZone: 'Asia/Shanghai'`
- `text-destructive-foreground` 在当前主题中未定义，destructive 按钮须用 `text-white` 代替；outline 按钮 hover 须加 `hover:bg-destructive/10` 覆盖默认 `bg-accent`
- `<onepassword-save-button>` Web Component 须带完整属性：`data-onepassword-type="login"` `:value="opSaveValue"` `lang="zh-CN"` `padding="none"`；localhost 下按钮会 disabled（扩展校验 URL）
- GET `/subscriptions` 有 `Cache-Control: max-age=10`；mutation 后 re-fetch 须传 `Cache-Control: no-cache` 请求头绕过浏览器 HTTP 缓存，或直接用 mutation 返回值更新 store

## 项目结构
- `src/index.ts` — 入口 (Hono app, CORS, routes, cron, queue handler, 安全头注入)
- `src/types.ts` — Env 接口定义
- `src/db/schema.ts` — Drizzle ORM 表定义 (users, subscriptions)；还导出 `SourceType` union、`PERSONAL_SOURCE_TYPES`/`EXPLORE_SOURCE_TYPES` 集合；`sourceType` 列用 `.$type<SourceType>()` 让 Drizzle 推断正确类型
- `src/services/` — 核心服务 (crypto, cqu-api, ics, export, auth, captcha, sync)
- `src/middleware/` — 中间件 (auth, rate-limit, security-headers)
- `src/routes/` — API 路由 (config, users, subscriptions, explore)
- `src/routes/config.ts` — 配置路由 (health check, merged config, captcha)
- `src/routes/config.test.ts` — config 路由测试 (health, merged config, captcha compat)
- `src/routes/validation.test.ts` — 输入验证测试
- `src/cron/` — 定时任务 producer + queue consumer (token-refresh, schedule-sync)
- `src/types/` — 类型声明补充 (headers.d.ts: Workers runtime API 类型)
- `src/utils/` — 共享工具 (token.ts: token 生成, time.ts: 中国时区格式化, error.ts: `errorResponse()` + `handleCquApiError()`, encoding.ts: Base64 编码, queue.ts: `spreadEnqueue` 分批入队)
- `frontend/` — Vue 前端 (独立 npm 项目)
- `frontend/vitest.config.ts` — 前端测试配置 (jsdom, @/ alias)
- `frontend/src/test-setup.ts` — 全局 mock (clipboard, hCaptcha, shadcn stubs)
- `frontend/src/test-utils.ts` — 测试工具 (mock factories, mountWithContext)
- `docs/plans/` — 设计文档和实现计划
- OAuth token (accessToken/refreshToken) 使用 AES-256-GCM 加密存储，读写路径:
  - 写入: `src/routes/users.ts` (注册+恢复), `src/cron/token-refresh.ts` (刷新+重登录)
  - 读取: `src/routes/subscriptions.ts`, `src/routes/explore.ts`, `src/cron/schedule-sync.ts`, `src/cron/token-refresh.ts`

## Agent skills

### Issue tracker

规格、任务和问题使用 `cqu-moe/schedule` 的 GitHub Issues；通过 `gh` 操作。见 [Issue tracker](docs/agents/issue-tracker.md)。

### Triage labels

使用默认五种 triage 角色标签，保留现有分类标签。见 [Triage labels](docs/agents/triage-labels.md)。

### Domain docs

采用 single-context：根目录 `GLOSSARY.md` 与按需创建的 `docs/adr/`。见 [Domain docs](docs/agents/domain.md)。
