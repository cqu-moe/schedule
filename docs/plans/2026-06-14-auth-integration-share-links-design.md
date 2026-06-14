# auth.cqu.moe 全面接入 + 共享链接 + 分级权益 设计

> 设计文档 · 2026-06-14 · 状态：**已定稿（brainstorm 完成，待出实现计划）**
> 仓库：`/Users/uu/Documents/Coding/cqu-moe/schedule-cloudflare`
> 关联：auth 仓库 `../auth/docs/subsystem-integration-guide.md`（接入契约）、`../auth/docs/plans/2026-06-14-firstparty-entitlements-design.md`（auth 侧分级权益设计）

## 0. 一句话

CQU 在 2026-06-10 启用「统一身份认证**增强登录**」（纯密码登录废除、上瑞数 WAF），本项目原有 HTTP 密码登录失效。本次**整库重建**：身份与 CQU 取票全面委托给 `auth.cqu.moe`（拓扑①：跨子域 cookie + Service Binding RPC），废弃旧 `users`/`subscriptions` 表，新增**每订阅多条共享链接 + 按格式分级访问**，并消费 auth 下发的**分级权益（caps）**做功能/配额门禁。

## 1. 范围与前提

- **本次只实现 schedule 侧**。auth 侧的 RPC（`verifySession`/`getCquTicket`）、entitlements、`capabilities.ts` 正由 auth 项目并行实现；schedule 严格**按接入指南的接口形状**编码，auth 照单实现。
- **忽略 PR #74**（第三方 OAuth 登录路径），不复用其流程，全面走拓扑①。
- **现有用户/订阅数据全部删除**，无数据迁移。
- CQU SSO 增强登录的 2FA / 无人值守会话续命，全部由 auth 的 `CquSessionDO` 承担，schedule 不感知。

## 2. 架构总览（拓扑①）

```
浏览器 ──登录态(.cqu.moe 跨子域 cookie)──▶ schedule.cqu.moe (本 Worker)
                                              │
   ┌──────────────────────────────────────────┤ Service Binding RPC (进程内, 不走公网)
   ▼                                           ▼
env.AUTH.verifySession(cookie)               env.AUTH.getCquTicket({clientId:"calendar",
   → null | {user, caps}                        service:"jwxt", userId}) → {ticket} | {error}
   │ 读 caps.calendar 做功能/配额门禁            │ schedule 保留: ST → exchangeTicketForCquToken → bearer
   ▼                                           ▼
本地 D1: subscriptions + calendar_links      CQUAPIClient(bearer) 拉课表/考试 → 生成 ICS/JSON/CSV 缓存
```

身份与 CQU 取票完全委托给 auth；schedule 只剩"业务数据 + 共享链接"。

### 2.1 对 auth 侧的依赖契约（schedule 期望 auth 提供）

1. **RPC（WorkerEntrypoint，service 名 `cqu-moe-auth`）**
   - `verifySession(cookieHeader: string): Promise<null | { user: { id, name, email, role }, caps: { calendar: {...} } }>`
   - `getCquTicket({ clientId, service?, serviceUrl?, userId }): Promise<{ ticket } | { error }>`
   - （可选）`getCaps(userId): Promise<{ calendar: {...} }>` 供 cron 离线读取；若 auth 不提供，schedule 用本地 caps 缓存兜底（见 §6.4）。
2. **跨子域 cookie SSO**：`crossSubDomainCookies({ domain: "cqu.moe" })` + `trustedOrigins` 含 `https://schedule.cqu.moe`、`https://schedule-beta.cqu.moe`。
3. **第一方 client `calendar`**：`skipConsent=true`、`metadata.subsystem="calendar"`、`oauth_client_cqu_scopes` 含 schedule 用的 jwxt 服务。
4. **`capabilities.ts` 的 `calendar` 子系统**：定义 §3 的 7 个 caps。
5. **默认预设**：新用户首次登录自动获得基础 caps（否则人人空权限、产品不可用）。
6. ⚠️ **服务 URL 对齐（唯一只能真账号实测的风险点）**：auth 的 `jwxt`（或专设 key）对应 serviceURL 必须 == schedule 换 bearer 用的 OAuth service URL，否则 ST 验票失败。

## 3. 分级权益（caps）契约

schedule 读取的 `calendar` 子系统能力（按指南 `caps.calendar.{...}` 形状；只读，不管来源）：

| key | 类型 | 含义 | 缺省/未授予 |
|---|---|---|---|
| `sync` | flag | 允许同步个人课表（基础能力） | 不能用日历服务 |
| `external` | flag | 允许创建**外部订阅**（教师/教室/课程等 explore 源） | 只能订阅自己课表 |
| `share` | flag | 允许创建**共享链接** | 只有默认链接 |
| `sub_limit` | quota·条 | 订阅数量上限（null=无限） | 视为 0 |
| `share_limit` | quota·条 | **每用户**分享链接总数上限（null=无限） | 视为 0 |
| `sync_interval` | quota·分钟 | 自动同步最小间隔（档位越高越小越新鲜） | 保守默认（如 1440） |
| `manual_refresh` | quota·次/天 | 手动"立即刷新"每日限额 | 视为 0（禁手动刷新） |

> 比指南示例（`sync`/`sync_limit`/`share`）多 4 个 key，归 auth 侧 `capabilities.ts` 补齐。

## 4. 数据库 Schema（旧两表整张废弃重建）

**关键决定：不再有本地 `users` 表。** 身份完全由 auth 持有，一切按 auth 的 `userId` 索引。

### 4.1 `subscriptions`（一个用户的一个日历源）

```ts
subscriptions {
  id            text PK              // crypto.randomUUID()（UUID）
  userId        text NOT NULL        // ← auth user.id：~32 字符 a-zA-Z0-9 随机串，【非 UUID】，无本地外键
  sourceType    text NOT NULL        // SourceType union（个人 + explore）
  sourceId      text NOT NULL
  sourceName    text NOT NULL
  sessionId     text
  sessionName   text
  semesterStart text                 // YYYY-MM-DD
  isPersonal    integer(bool) DEFAULT 0
  icsContent    text                 // 缓存 ICS
  coursesJson   text                 // 缓存原始数据(JSON)
  examsJson     text
  lastSyncedAt  text
  createdAt / updatedAt text
}
// UNIQUE(userId, sourceType, sourceId, sessionId) + INDEX(userId)
// 删掉旧 calendarToken —— token 全迁到 calendar_links
```

### 4.2 `calendar_links`（一个订阅的多条链接，统一同构）

```ts
calendar_links {
  id             text PK             // UUID
  subscriptionId text NOT NULL → subscriptions.id ON DELETE CASCADE
  token          text UNIQUE NOT NULL  // 64-char 随机，公开 URL token
  label          text                  // 可选，标识分享对象（如"给室友"）
  formats        text NOT NULL         // JSON 数组: ["ics","origin_json","data_json","csv","web"]
  isDefault      integer(bool) NOT NULL DEFAULT 0  // 默认链接=全格式、不可删、不可改格式
  createdAt / updatedAt text
}
// INDEX(subscriptionId)
```

### 4.3 配额落表

- `sub_limit`：`COUNT(subscriptions WHERE userId=?)`
- `share_limit`：`COUNT(calendar_links JOIN subscriptions WHERE userId=? AND isDefault=0)`（默认链接不计入）
- `formats`：默认链接固定全集；分享链接是子集，建/改时校验 `⊆` 全集。

### 4.4 关键约束 / 坑

- **`userId` 非 UUID**：auth user.id 是 Better Auth(v1.6.11) 默认 `generateId` 的 ~32 字符 a-zA-Z0-9 串；本地 `id` 才是 UUID。任何中间件**禁止**用 UUID 正则校验 `userId`。
- **无本地 users 表的代价**：auth 删用户时 schedule 不知情 → 可能留孤儿订阅。列为**已知缺口**，后续用对账 cron 或 auth webhook 清理（YAGNI，先不做）。
- `formats` 用 JSON TEXT（沿用 coursesJson 模式）而非多 bool 列：加新格式不用 migration；访问路径永远是"先按 token 取链接、再查 formats 含某格式"，不需按格式建索引。

## 5. RESTful API（全部 `/api/v2/` 前缀，v1 整套删除）

```
# 公开链接 (按 link token, 无需登录)
GET  /api/v2/calendar/:token/calendar.ics
GET  /api/v2/calendar/:token/origin.json     # 原始 JSON
GET  /api/v2/calendar/:token/data.json       # 格式化 JSON
GET  /api/v2/calendar/:token/data.csv
GET  /view/:token                            # 前端只读日历页(复用现有页面), 非 /api/不带版本

# 当前用户 (singleton)
GET    /api/v2/me                            # user + caps

# 订阅 (resource)
GET    /api/v2/subscriptions
POST   /api/v2/subscriptions                 # 创建 → 201 + Location; external 需 caps.external; 校验 < sub_limit; 自动建默认链接
GET    /api/v2/subscriptions/:sid
DELETE /api/v2/subscriptions/:sid            # 级联删 links → 204

# 链接 (嵌套子资源, 层级一致)
GET    /api/v2/subscriptions/:sid/links
POST   /api/v2/subscriptions/:sid/links      # 创建分享链接 → 201 + Location; caps.share + 用户总数 < share_limit; formats ⊆ 全集
GET    /api/v2/subscriptions/:sid/links/:lid
PATCH  /api/v2/subscriptions/:sid/links/:lid # 改 label/formats; isDefault → 403
DELETE /api/v2/subscriptions/:sid/links/:lid # isDefault → 403; 否则 204

# 动作 = 子资源创建 (REST 化, 取代动词)
POST   /api/v2/subscriptions/:sid/syncs                      # 手动刷新 → 202 Accepted (入队), 按 manual_refresh 限流
POST   /api/v2/subscriptions/:sid/links/:lid/rotations      # 换 token → 201, body 返回新 token

# 兼容兜底
ALL    /api/v1/*                             # → 410 Gone / "请刷新页面" (避免缓存旧前端裸 404)
```

### 5.1 公开格式端点门禁

- token 查不到 → `404`。
- token 有效但请求格式不在 `link.formats` → `403 FORMAT_NOT_ALLOWED`。
- `/view/:token` 的"web"是独立访问方式：前端页 + 其后台数据取数（`view.json`，受 `web` 格式门禁），与 `data.json` 下载权限相互独立。

### 5.2 状态码语义

201 创建（+`Location`）/ 204 删除 / 202 异步同步 / 409 `QUOTA_EXCEEDED` / 403 `FEATURE_NOT_ENABLED`、默认链接保护 / 429 手动刷新超频 / 401 未登录 / 409（或 auth 计划中的 SESSION 状态码）未绑定 CQU。

## 6. 中间件与同步

### 6.1 `sessionMiddleware`

`env.AUTH.verifySession(cookie)` → 注入 `user`+`caps`，`null`→401。**顺带把 caps 写入 KV 缓存**（`caps:<userId>`，TTL≈1h）供 cron 离线读取。

### 6.2 entitlement 助手

`requireFlag('share' | 'external')`、`checkQuota(kind, currentCount)`，统一抛 `errorResponse`。

### 6.3 自动同步 cron + consumer

- **cron**（如每 30 min）：扫 subscriptions → 按 userId 读缓存 `sync_interval` → 选出到期（`now - lastSyncedAt ≥ interval`）→ `spreadEnqueue` 到 `schedule-sync` 队列分散投递。
- **consumer**：`getCquTicket({clientId:"calendar",service:"jwxt",userId})` → 出错（SESSION_INACTIVE 等）记录跳过 → `exchangeTicketForCquToken(ST)` → bearer（KV 短缓存 `bearer:<userId>` 减 auth 压力）→ `CQUAPIClient` 拉数据 → 重生成 ICS/JSON 写回订阅 + `lastSyncedAt`。

### 6.4 手动刷新

`POST .../syncs` → KV 计数 `refresh:<userId>:<日期>` 对比 `caps.manual_refresh`，超额 `429`，否则即时入队单订阅同步，返回 `202`。

### 6.5 删除项

`token-refresh` cron + 队列整体删除；`ENCRYPTION_KEY` + `src/services/crypto.ts`（AES-256-GCM）因不再存任何本地凭据**一并移除**；`src/services/captcha.ts`、密码登录/注册/找回端点删除。

### 6.6 个人订阅身份绑定（安全不变量）⚠️

**不变量**：个人订阅（`personal_*`）的课表拉取**始终绑定已认证 bearer 主体自己的学号**，**绝不信任** client 传入的 `sourceId`。

**背景（为何必须）**：个人课表经**公开链接 token** 对外提供，且 CQU `student/my-table-detail` 按 POST body 里的学号拉课表。若用 client 任意传入的 `sourceId` 当学号去拉，攻击者构造一个"别人的学号" → 别人的私人课表被拉到并经公开链接泄露（跨学生数据泄露）。

**机制**：

- **学号来源 = bearer JWT 的 `user_name` claim**。CQU 教务 OAuth access_token 是 JWT，payload 携带 `"user_name": "<学号>"`（逆向：`cqu-api-endpoint-collection/systems/jwxt/notes.md`）。该 claim 即 bearer 的认证主体，无法被 client 伪造。`session/info-detail` 响应**不含**学号（仅 `curSessionId`/`sessionFinder`），故不走该接口。
- `decodeStudentIdFromBearer(bearer)`（`src/services/cqu-api.ts`）解码 `user_name`；`resolveOwnStudentId(env, userId, bearer)`（`src/services/cqu-bearer.ts`）在此之上加 KV 缓存 `student:<userId>`（30d TTL，学号不变），避免每次 sync 重复解码。解析不出学号时返回 `null`，consumer ack-and-skip（不重试），不阻塞 batch。
- **同步**（`src/cron/schedule-sync.ts` 个人分支）：`getSchedule(resolvedStudentId, sessionId)` 用解析出的**自己学号**，ICS UID 命名空间亦用该可信值（每用户稳定）；不再读 `sub.sourceId`。
- **创建端点**（`POST /api/v2/subscriptions`，`src/routes/v2/subscriptions.ts`）：个人源类型**忽略 client `sourceId`**，固定写入 `user.id`（auth userId）——它只作每用户稳定标识（唯一约束 `uq_user_source_session` + ICS UID 命名空间），不再参与 CQU 拉取。
- **explore 类型不变**（`instructor`/`room`/`laboratory`/`course`/`admin_class`）：订阅他人**公开**时刻表，client 传 target id 是正确语义，保持现状。

## 7. 前端

- 未登录 → `location` 跳 `https://auth.cqu.moe/login?redirect=<当前页>`。
- Dashboard 按 `/api/v2/me` 的 caps 条件渲染"建外部订阅 / 建分享链接"+ 显示额度用量。
- 订阅下链接管理 UI：格式勾选、复制 URL、`label`、删除、换 token；默认链接标记不可删。
- `/view/:token` 复用现有 FullCalendar 日历页（公开只读、按 token 取数）。
- **删光**密码登录/注册/找回 UI。
- **本地开发**：localhost 收不到 `.cqu.moe` cookie → 提供 dev-only mock AUTH binding（固定 user+caps + mock ticket），`npm run dev` 可离线跑。

## 8. 错误处理

沿用 `{ detail: { error: { code, message } } }`（`errorResponse()`）：401 未登录（前端跳转）、未绑定 CQU（引导去 auth 绑定页）、403 `FEATURE_NOT_ENABLED`、409 `QUOTA_EXCEEDED`、429 手动刷新超限、403/404 格式门禁。

## 9. 测试策略（vitest v3 + @cloudflare/vitest-pool-workers）

- **mock `env.AUTH` binding**（`verifySession`/`getCquTicket`/`getCaps`）。
- 覆盖：功能门禁（flag）、配额（sub_limit / share_limit 跨订阅计数）、默认链接不可删/不可改格式、格式门禁（允许/拒绝各格式）、换 token、手动刷新限流、cron 按间隔挑选订阅、公开端点无需登录。
- 前端：caps 条件 UI、链接管理、`/view/:token` 只读页。

## 10. 迁移 / 部署

- 新 Drizzle schema → `npm run db:generate` 生成全新 migration（drop 旧 `users`+`subscriptions`，建新 `subscriptions`+`calendar_links`）。
- 部署后 **必须** `npx wrangler d1 migrations apply schedule-beta-cqu-moe-db --remote`。
- `wrangler.jsonc`：加 `services:[{ binding:"AUTH", service:"cqu-moe-auth" }]`；删 `token-refresh` cron trigger 与队列；保留 `schedule-sync` cron+队列；移除 `ENCRYPTION_KEY` secret 用途。
- KV `CACHE` 复用（caps 缓存、bearer 缓存、刷新计数）。

## 11. 实现方式

按用户要求，实现阶段采用 **subagent-driven-development**（见 writing-plans 产出的实现计划逐任务派发）。

## 12. 风险与开放项

1. **服务 URL 对齐**（§2.1.6）——唯一只能真账号实测的假设。
2. **auth 侧未就绪**：RPC/caps 并行开发中，联调前需确认 auth 已上线对应接口。
3. **孤儿订阅**：无本地 users 表 → auth 删用户后留存（已知缺口，暂不处理）。
4. **caps 缓存陈旧**：用户离线期间降档不立即生效（仅影响 sync_interval，非安全项，可接受）。
