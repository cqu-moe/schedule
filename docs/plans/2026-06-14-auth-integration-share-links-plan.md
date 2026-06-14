# auth.cqu.moe 接入 + 共享链接 + 分级权益 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 schedule 项目从「本地密码登录 + 单 token 订阅」整库重建为「auth.cqu.moe 委托身份(拓扑①) + 每订阅多条按格式分级的共享链接 + 消费 caps 做配额门禁」。

**Architecture:** 拓扑①——浏览器跨子域 cookie 登录态，后端经 Service Binding RPC 调 `env.AUTH.verifySession`/`getCquTicket`；身份/CQU 会话续命全在 auth 侧，schedule 不存任何凭据。本地 D1 只剩 `subscriptions` + `calendar_links` 两表，按 auth `userId` 索引。

**Tech Stack:** Cloudflare Workers + Hono + Drizzle ORM + D1 + KV + Queues；vitest v3 + @cloudflare/vitest-pool-workers；前端 Vue 3 + shadcn-vue + FullCalendar。

**设计依据:** `docs/plans/2026-06-14-auth-integration-share-links-design.md`

---

## 通用约定（每个任务都适用）

- **TDD**：先写失败测试 → 跑红 → 最小实现 → 跑绿 → commit。
- **跑后端测试**：`npx vitest run --exclude 'frontend/**' <file>`（直接 `npm test` 会误拾 frontend 测试）。
- **跑前端测试**：`npm run test:frontend`。
- **typecheck**：`npm run typecheck`。
- **mock `env.AUTH`**：测试里用 `cloudflare:test` 的 `env`，给 `env.AUTH` 注入一个假对象（见 Task B2 的 mock 实现，测试中可 `vi.spyOn` 或直接构造）。
- **结构化日志**：`console.log(JSON.stringify({ event: "context.subsystem.action", message, ...fields }))`。
- **错误响应**：一律 `errorResponse(code, message, status)`（`src/utils/error.ts`）。
- **commit 粒度**：每个 Task 末尾 commit 一次；message 用 conventional commits，末尾加
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **分支**：已在 `feat/auth-integration-share-links`。

---

## Phase A — 数据模型与绑定

### Task A1: 重建 DB schema（drop users，新建 subscriptions + calendar_links）

**Files:**
- Modify: `src/db/schema.ts`（整表替换 users/subscriptions；保留 SOURCE_TYPES 等常量）

**Step 1: 写 schema**

删除 `users` 表定义与其 `User`/`NewUser` 导出。重建 `subscriptions`（去掉 `calendarToken`，`userId` 不再 `references`，加注释「auth user.id，非 UUID」），新增 `calendar_links`：

```ts
// ── Calendar links（一个订阅的多条链接，统一同构）─────────────────────
export const LINK_FORMATS = ["ics", "origin_json", "data_json", "csv", "web"] as const;
export type LinkFormat = (typeof LINK_FORMATS)[number];

export const calendarLinks = sqliteTable(
  "calendar_links",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    label: text("label"),
    /** JSON array of LinkFormat */
    formats: text("formats").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_calendar_links_subscription_id").on(t.subscriptionId)],
);

export type CalendarLink = typeof calendarLinks.$inferSelect;
export type NewCalendarLink = typeof calendarLinks.$inferInsert;
```

`subscriptions.userId` 改为 `text("user_id").notNull()`（删 `.references`）。删除 `subscriptions.calendarToken` 列。保留 `SOURCE_TYPES`/`PERSONAL_SOURCE_TYPES`/`EXPLORE_SOURCE_TYPES`。

**Step 2: 生成 migration**

Run: `npm run db:generate`
Expected: 在 `drizzle/migrations/` 生成新 migration（drop users、alter subscriptions、create calendar_links）。打开确认无误。

**Step 3: typecheck**

Run: `npm run typecheck`
Expected: schema 本身无错（引用旧 `User`/`calendarToken` 的文件会报错——这些将在后续任务删除/改写，本步只确认 schema.ts 自身 OK；其余错误记下作为后续任务清单）。

**Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/migrations
git commit -m "feat(db): 重建 schema —— 废 users 表, subscriptions 去 token, 新增 calendar_links"
```

---

### Task A2: Env 类型 + wrangler AUTH binding

**Files:**
- Modify: `src/types.ts`
- Modify: `wrangler.jsonc`

**Step 1: 加 AUTH service binding 类型**

`src/types.ts` 的 `Env` 加：
```ts
  // Auth service (拓扑①: Service Binding RPC to cqu-moe-auth)
  AUTH: import("./services/auth-rpc").AuthService;
```
（`AuthService` 接口在 Task B1 定义；此处用 inline import 类型，B1 完成前 typecheck 会缺类型——B1 紧接其后。）

**Step 2: wrangler 加 binding**

`wrangler.jsonc` 顶层加：
```jsonc
  "services": [
    { "binding": "AUTH", "service": "cqu-moe-auth" }
  ],
```

**Step 3: Commit**（typecheck 留到 B1 后）

```bash
git add src/types.ts wrangler.jsonc
git commit -m "feat: 加 AUTH service binding (拓扑① RPC 接入 cqu-moe-auth)"
```

---

## Phase B — Auth 集成层

### Task B1: caps 类型 + auth-rpc 封装

**Files:**
- Create: `src/services/auth-rpc.ts`
- Test: `src/services/auth-rpc.test.ts`

**Step 1: 写类型与契约**

```ts
// src/services/auth-rpc.ts
export interface CalendarCaps {
  sync: boolean;
  external: boolean;
  share: boolean;
  sub_limit: number | null;     // null = 无限
  share_limit: number | null;
  sync_interval: number | null; // 分钟
  manual_refresh: number | null;// 次/天
}
export interface SessionUser { id: string; name: string; email: string; role: string; }
export interface VerifiedSession { user: SessionUser; caps: { calendar: CalendarCaps } }

export interface GetCquTicketArgs {
  clientId: string; service?: string; serviceUrl?: string; userId: string;
}
export type GetCquTicketResult = { ticket: string } | { error: string };

/** auth Worker 暴露的 RPC（WorkerEntrypoint）契约 */
export interface AuthService {
  verifySession(cookieHeader: string): Promise<VerifiedSession | null>;
  getCquTicket(args: GetCquTicketArgs): Promise<GetCquTicketResult>;
  getCaps?(userId: string): Promise<{ calendar: CalendarCaps } | null>;
}

/** 缺省/兜底 caps：未授予时的安全保守值 */
export const DENY_CAPS: CalendarCaps = {
  sync: false, external: false, share: false,
  sub_limit: 0, share_limit: 0, sync_interval: 1440, manual_refresh: 0,
};
```

加一个纯函数 `resolveQuota(limit: number | null): number` → `limit === null ? Infinity : limit`，便于配额比较与测试。

**Step 2: 写测试（纯函数）**

```ts
// src/services/auth-rpc.test.ts
import { describe, it, expect } from "vitest";
import { resolveQuota, DENY_CAPS } from "./auth-rpc";
describe("resolveQuota", () => {
  it("null → Infinity", () => expect(resolveQuota(null)).toBe(Infinity));
  it("number passthrough", () => expect(resolveQuota(5)).toBe(5));
  it("DENY_CAPS 全部拒绝", () => {
    expect(DENY_CAPS.sync).toBe(false);
    expect(DENY_CAPS.sub_limit).toBe(0);
  });
});
```

**Step 3-4: 实现 → 跑绿**

Run: `npx vitest run --exclude 'frontend/**' src/services/auth-rpc.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/auth-rpc.ts src/services/auth-rpc.test.ts
git commit -m "feat(auth): caps 类型 + auth RPC 契约 + resolveQuota"
```

---

### Task B2: dev mock AUTH binding

**Files:**
- Create: `src/services/auth-mock.ts`
- Modify: `src/index.ts`（仅 dev 环境注入）

**Step 1: 实现 mock**

```ts
// src/services/auth-mock.ts —— 仅本地开发用，localhost 收不到 .cqu.moe cookie
import type { AuthService, VerifiedSession, GetCquTicketResult } from "./auth-rpc";

export function createMockAuth(): AuthService {
  const session: VerifiedSession = {
    user: { id: "devuser000000000000000000000000", name: "开发者", email: "dev@cqu.moe", role: "user" },
    caps: { calendar: { sync: true, external: true, share: true,
      sub_limit: 10, share_limit: 20, sync_interval: 60, manual_refresh: 20 } },
  };
  return {
    async verifySession() { return session; },
    async getCquTicket(): Promise<GetCquTicketResult> { return { error: "DEV_NO_TICKET" }; },
    async getCaps() { return session.caps; },
  };
}
```

**Step 2: 在 index.ts 注入（dev 判定）**

在 fetch handler 入口处：若 `!c.env.AUTH`（本地未配 service binding）则 `c.env.AUTH = createMockAuth()`。用一个轻量中间件实现，仅当 `AUTH` 为 undefined 时注入，生产环境 binding 存在故不触发。

**Step 3: Commit**

```bash
git add src/services/auth-mock.ts src/index.ts
git commit -m "feat(auth): dev-only mock AUTH binding（localhost 离线开发）"
```

---

### Task B3: session 中间件（verifySession + caps KV 缓存）

**Files:**
- Create: `src/middleware/session.ts`
- Test: `src/middleware/session.test.ts`

**Step 1: 失败测试**

测 3 个行为：无 cookie/`verifySession` 返 null → 401；有效 session → `c.get("user")`/`c.get("caps")` 注入且 `next()` 通过；通过时写入 KV `caps:<userId>`。用假 `env.AUTH`（实现 `verifySession`）+ 真 `env.CACHE`（来自 `cloudflare:test`）。

**Step 2: 实现**

```ts
// src/middleware/session.ts
import type { Context, Next } from "hono";
import { errorResponse } from "../utils/error";
import type { Env } from "../types";
import type { SessionUser, CalendarCaps } from "../services/auth-rpc";

export type SessionEnv = { Bindings: Env; Variables: { user: SessionUser; caps: { calendar: CalendarCaps } } };
const CAPS_TTL = 3600;

export async function sessionMiddleware(c: Context<SessionEnv>, next: Next) {
  const cookie = c.req.header("cookie") ?? "";
  const sess = await c.env.AUTH.verifySession(cookie);
  if (!sess) return errorResponse("UNAUTHORIZED", "未登录", 401);
  c.set("user", sess.user);
  c.set("caps", sess.caps);
  // 缓存 caps 供 cron 离线读取（best-effort）
  await c.env.CACHE.put(`caps:${sess.user.id}`, JSON.stringify(sess.caps.calendar),
    { expirationTtl: CAPS_TTL }).catch(() => {});
  await next();
}
```

**Step 3-4: 跑绿**

Run: `npx vitest run --exclude 'frontend/**' src/middleware/session.test.ts`

**Step 5: Commit**

```bash
git add src/middleware/session.ts src/middleware/session.test.ts
git commit -m "feat(auth): session 中间件 verifySession + caps KV 缓存"
```

---

### Task B4: entitlement 门禁助手

**Files:**
- Create: `src/middleware/entitlements.ts`
- Test: `src/middleware/entitlements.test.ts`

**Step 1: 失败测试**（纯逻辑，不依赖 Hono）

测 `assertFlag(caps, 'share')` flag=false → 抛带 code `FEATURE_NOT_ENABLED`；`assertQuota('sub_limit', caps, currentCount)`：count≥limit → 抛 `QUOTA_EXCEEDED`；limit=null → 永不抛；limit=0 → count=0 即抛。

**Step 2: 实现**

```ts
// src/middleware/entitlements.ts
import type { CalendarCaps } from "../services/auth-rpc";
import { resolveQuota } from "../services/auth-rpc";

export class EntitlementError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
type FlagKey = "sync" | "external" | "share";
type QuotaKey = "sub_limit" | "share_limit" | "manual_refresh";

export function assertFlag(caps: CalendarCaps, key: FlagKey, label: string): void {
  if (!caps[key]) throw new EntitlementError("FEATURE_NOT_ENABLED", 403, `${label}未开通`);
}
export function assertQuota(caps: CalendarCaps, key: QuotaKey, current: number, label: string): void {
  const limit = resolveQuota(caps[key]);
  if (current >= limit) throw new EntitlementError("QUOTA_EXCEEDED", 409, `${label}已达上限 ${caps[key]}`);
}
```

在路由层 `try/catch (EntitlementError)` → `errorResponse(e.code, e.message, e.status)`（或写个 helper）。

**Step 3-5:** 跑绿 + commit。
```bash
git commit -am "feat(auth): entitlement 门禁助手 assertFlag/assertQuota"
```

---

## Phase C — CQU ticket 换 bearer（保留 + 抽取）

### Task C1: 抽取 exchangeTicketForCquToken，删密码登录

**Files:**
- Modify: `src/services/auth.ts`（删 `login` 步骤 1-2 / `refreshToken` / captcha 分支；抽出步骤 3-5）
- Modify/Delete: `src/services/captcha.ts`（删）
- Test: `src/services/auth.test.ts`（重写——只测 `exchangeTicketForCquToken`）

**Step 1: 失败测试**

保留/重写 `auth.test.ts`：mock fetch（`CAS_SERVICE_URL?ticket=` → 返 `SESSION` cookie → OAuth code → token）测 `exchangeTicketForCquToken(ticket)` 返回 `{ accessToken, refreshToken? }`。删除所有 `login()`/captcha 相关用例。

**Step 2: 实现**

把现有 `login()` 第 266 行起（Step 3 起）逻辑抽成 `export async function exchangeTicketForCquToken(ticket: string): Promise<TokenResult>`。删除步骤 1-2、`refreshToken`、`CaptchaError`、captcha count 逻辑、`parseLoginPage`/`extractLoginError`（如仅 login 用）。保留 `extractCookie`/`USER_AGENT`/超时等被 exchange 复用的工具。

**Step 3-4:** Run: `npx vitest run --exclude 'frontend/**' src/services/auth.test.ts` → PASS

**Step 5: Commit**

```bash
git rm src/services/captcha.ts
git add src/services/auth.ts src/services/auth.test.ts
git commit -m "refactor(auth): 抽出 exchangeTicketForCquToken, 删密码登录/captcha（增强登录已废除）"
```

---

## Phase D — 订阅 v2 API

> 全部挂在 `sessionMiddleware` 之后；`c.get("user")`/`c.get("caps")` 可用。新建 `src/routes/v2/subscriptions.ts`。

### Task D1: list / get 订阅

**Files:** Create `src/routes/v2/subscriptions.ts`；Test `src/routes/v2/subscriptions.test.ts`

- `GET /` → 该 user 全部订阅（join 出每个订阅的 links 概要）。
- `GET /:sid` → 单订阅（404 若不属于该 user）。
- 测试：插入两 user 的订阅，断言只返回当前 user 的；跨 user 取 `:sid` → 404。
- Commit: `feat(api): v2 订阅 list/get`

### Task D2: create 订阅（+ 自动默认链接 + caps 门禁）

**核心逻辑（含完整代码）:**

```ts
// POST /  body: { sourceType, sourceId, sourceName, sessionId?, sessionName?, semesterStart?, isPersonal? }
const user = c.get("user"); const caps = c.get("caps").calendar;
const body = await c.req.json();
const isExternal = EXPLORE_SOURCE_TYPES.has(body.sourceType);
if (isExternal) assertFlag(caps, "external", "外部订阅");
else assertFlag(caps, "sync", "日历同步");
// 配额：现有订阅数
const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)` })
  .from(subscriptions).where(eq(subscriptions.userId, user.id));
assertQuota(caps, "sub_limit", cnt ?? 0, "订阅数量");
// 建订阅 + 默认链接（全格式、isDefault）—— 同事务语义（D1 batch）
const subId = crypto.randomUUID();
const token = await generateUniqueToken((t) => linkTokenExists(db, t));
await db.batch([
  db.insert(subscriptions).values({ id: subId, userId: user.id, ...body }),
  db.insert(calendarLinks).values({
    subscriptionId: subId, token, formats: JSON.stringify([...LINK_FORMATS]), isDefault: true,
  }),
]);
return c.json({ id: subId, /* ... */ }, 201, { Location: `/api/v2/subscriptions/${subId}` });
```

- 复用 `generateUniqueToken`（`src/utils/token.ts`）；新增 `linkTokenExists(db, t)` 查 `calendar_links`。
- 测试：external 无 `external` cap → 403；超 `sub_limit` → 409；成功 → 201 + 自动建了一条 `isDefault` 全格式链接 + `Location` 头。
- Commit: `feat(api): v2 创建订阅 + 自动默认链接 + caps 门禁`

### Task D3: delete 订阅

- `DELETE /:sid` → 404 若非本人；否则删（cascade 删 links）→ 204。
- 测试：删除后 links 也没了；跨 user 删 → 404。
- Commit: `feat(api): v2 删除订阅（级联删链接）`

---

## Phase E — 链接 v2 API（嵌套在 /subscriptions/:sid/links）

### Task E1: formats 校验工具

**Files:** Create `src/services/links.ts`；Test `src/services/links.test.ts`

```ts
import { LINK_FORMATS, type LinkFormat } from "../db/schema";
export function parseFormats(raw: unknown): LinkFormat[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("INVALID_FORMATS");
  const set = new Set<string>(raw);
  for (const f of set) if (!LINK_FORMATS.includes(f as LinkFormat)) throw new Error("INVALID_FORMATS");
  return [...set] as LinkFormat[];
}
export function linkAllows(formatsJson: string, fmt: LinkFormat): boolean {
  try { return (JSON.parse(formatsJson) as string[]).includes(fmt); } catch { return false; }
}
```
- 测试：合法子集通过；含非法格式抛错；空数组抛错；`linkAllows` 命中/未命中/坏 JSON。
- Commit: `feat(links): formats 解析/校验工具`

### Task E2: list/get 链接
- `GET /subscriptions/:sid/links`、`GET .../links/:lid`（校验 sub 属本人）。Commit。

### Task E3: create 分享链接（caps.share + 每用户 share_limit + formats）

```ts
assertFlag(caps, "share", "共享链接");
// 每用户分享链接总数（排除默认）
const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)` })
  .from(calendarLinks).innerJoin(subscriptions, eq(calendarLinks.subscriptionId, subscriptions.id))
  .where(and(eq(subscriptions.userId, user.id), eq(calendarLinks.isDefault, false)));
assertQuota(caps, "share_limit", cnt ?? 0, "共享链接");
const formats = parseFormats(body.formats); // 子集校验
// insert（isDefault=false）→ 201 + Location
```
- 测试：无 share cap → 403；超 share_limit（跨多个订阅累计）→ 409；非法 formats → 400；成功 201。
- Commit: `feat(api): v2 创建分享链接 + share_limit 跨订阅计数`

### Task E4: patch 链接（默认链接保护）
- `PATCH .../links/:lid`：`isDefault` → 403 `DEFAULT_LINK_IMMUTABLE`；否则改 `label`/`formats`（formats 经 `parseFormats`）。测试默认拒、普通改成功。Commit。

### Task E5: delete 链接（默认链接保护）
- `DELETE .../links/:lid`：`isDefault` → 403；否则删 → 204。测试。Commit。

### Task E6: rotations（换 token）
- `POST .../links/:lid/rotations`：生成新唯一 token，更新该 link，返回 `201 { token, url }`（含默认链接也可换）。测试旧 token 失效、新 token 生效。Commit。

---

## Phase F — 公开格式端点（按 token，无需登录）

### Task F1: link 解析 + 格式门禁 helper

**Files:** Create `src/routes/v2/calendar.ts`；Test `src/routes/v2/calendar.test.ts`

helper：`resolveLinkOr404(db, token)` → join 出 link + 其 subscription（含 ics/courses/exams/semester/session）；`gateFormat(link, fmt)` → 不含则 `403 FORMAT_NOT_ALLOWED`。

### Task F2: ics / origin.json / data.json / data.csv
- 复用现有 `export.ts`（`generateFormattedEvents`/`generateCsv`/`semesterShortName`）与 `EMPTY_ICS`。
- 每个端点：`resolveLinkOr404` → `gateFormat` → 返回对应内容（沿用现有 Content-Type / Cache-Control / Content-Disposition）。
- `rateLimit("UNAUTH_LIMITER")` 保留。
- 测试：默认链接全格式可取；只含 `["web"]` 的链接取 `.ics` → 403；未知 token → 404。
- Commit: `feat(api): v2 公开格式端点 + 按 token 格式门禁`

### Task F3: view.json + 前端 view 路由后端
- `GET /api/v2/calendar/:token/view.json`：`gateFormat(link, "web")` → 返回前端日历页渲染所需 JSON（events，复用 `generateFormattedEvents`，结构同 `data.json` 但门禁看 `web`）。
- 测试：含 `web` 可取；不含 → 403。
- Commit: `feat(api): v2 view.json（网页只读视图数据，web 格式门禁）`

---

## Phase G — 同步 / 刷新

### Task G1: schedule-sync consumer 重构（getCquTicket + exchange + bearer 缓存）

**Files:** Modify `src/cron/schedule-sync.ts`；Test `src/cron/schedule-sync.test.ts`

- `ScheduleSyncMessage` 改为 `{ subscriptionId: string; userId: string }`。
- consumer 每条：
  ```ts
  const t = await env.AUTH.getCquTicket({ clientId: "calendar", service: "jwxt", userId: msg.userId });
  if ("error" in t) { log skip; ack; return; }
  const bearer = await getOrMintBearer(env, msg.userId, t.ticket); // KV cache `bearer:<userId>`
  const api = new CQUAPIClient(bearer);
  // 拉数据 → 重生成 ICS/JSON → update subscription + lastSyncedAt
  ```
- `getOrMintBearer`：读 KV `bearer:<userId>`；miss → `exchangeTicketForCquToken(ticket)` → 写 KV（TTL≈3h）。
- 删除所有 `users.accessToken`/`decrypt` 读取。
- 测试：mock `env.AUTH.getCquTicket` 返 ticket + mock exchange/CQUAPIClient；断言订阅被更新；`getCquTicket` 返 error → 跳过不抛。
- Commit: `refactor(cron): schedule-sync 改用 auth getCquTicket + bearer 缓存`

### Task G2: 自动同步 cron producer（按 sync_interval 选订阅）

**Files:** Modify `src/cron/` producer + `src/index.ts` scheduled switch

- cron `0 * * * *`（每小时）：
  - 查全部 subscriptions（id, userId, lastSyncedAt）。
  - 按 userId 读 KV `caps:<userId>` 取 `sync_interval`（缺失 → 默认 1440）。
  - 选 `now - lastSyncedAt ≥ interval` 的 → `spreadEnqueue`（`src/utils/queue.ts`）到 `SCHEDULE_SYNC_QUEUE`，每条带 `{subscriptionId,userId}`。
- 更新 `src/index.ts` scheduled switch（cron 表达式两处同步——见 CLAUDE.md）。
- 测试：到期/未到期筛选；缺 caps 用默认间隔。
- Commit: `feat(cron): 自动同步按 sync_interval 档位挑选到期订阅`

### Task G3: 手动刷新 POST syncs（+ KV 限流）

**Files:** Add route to `src/routes/v2/subscriptions.ts`；Test

- `POST /subscriptions/:sid/syncs`：校验 sub 属本人 → KV `refresh:<userId>:<yyyy-mm-dd>` 计数 vs `caps.manual_refresh`，超额 `429 RATE_LIMITED`；否则 `SCHEDULE_SYNC_QUEUE.send({subscriptionId,userId})` → `202`。
- 测试：超额 429；正常 202 且入队。
- Commit: `feat(api): v2 手动刷新（POST syncs）+ 每日配额限流`

### Task G4: 删除 token-refresh cron/queue

**Files:** Delete `src/cron/token-refresh.ts` + 其测试；Modify `wrangler.jsonc`、`src/index.ts`、`src/types.ts`

- 删 `TOKEN_REFRESH_QUEUE`（producer+consumer+Env 字段+import）。
- `wrangler.jsonc` crons 去掉旧的、只留同步用的；queues 去掉 `schedule-token-refresh`。
- `src/index.ts` queue handler 去掉 token-refresh 分支；scheduled switch 去掉对应 case。
- Commit: `chore(cron): 删除 token-refresh（auth DO 已无人值守续命 CQU 会话）`

---

## Phase H — index.ts 装配 + 清理

### Task H1: 挂载 v2 路由 + v1 catch-all + 删旧路由

**Files:** Modify `src/index.ts`；Delete `src/routes/users.ts`、旧 `src/routes/subscriptions.ts`、`src/routes/explore.ts`（逻辑并入 v2）及其测试

- 挂载：`app.route("/api/v2/subscriptions", subscriptionsV2)`、`app.route("/api/v2/calendar", calendarV2)`、`GET /api/v2/me`（返回 `c.get("user")` + `c.get("caps")`）。
- `sessionMiddleware` 套在 `/api/v2/subscriptions/*` 与 `/api/v2/me`（**公开** `/api/v2/calendar/*` 不套）。
- `app.all("/api/v1/*", c => errorResponse("GONE", "接口已升级，请刷新页面", 410))`。
- 前端 view 路由：`GET /view/:token` 交给 ASSETS（SPA）——确认 `run_worker_first` 下 `/view/*` 落到静态资源；如被 worker 截获则显式 `c.env.ASSETS.fetch`。
- Commit: `feat: 装配 v2 路由 + v1 catch-all(410) + 删旧路由`

### Task H2: 删 crypto/captcha/ENCRYPTION_KEY 残留

**Files:** Delete `src/services/crypto.ts`(+test)；Modify `src/types.ts`、`wrangler.jsonc`

- 全局 grep `encrypt(`/`decrypt(`/`ENCRYPTION_KEY`/`HCAPTCHA`/`MAX_SUBSCRIPTIONS` 确认无引用后删除 Env 字段与 vars（`MAX_SUBSCRIPTIONS` 被 caps 取代）。
- Run: `npm run typecheck` → 全绿。
- Run: `npx vitest run --exclude 'frontend/**'` → 全绿。
- Commit: `chore: 移除 crypto/captcha/ENCRYPTION_KEY（不再存本地凭据）`

---

## Phase I — 前端

> 现有 store/SFC 全 `<script setup lang="ts">`；shadcn-vue + FullCalendar。逐任务跑 `npm run test:frontend` + `cd frontend && npm run build`。

### Task I1: 登录跳转 + caps store
- axios 401 interceptor（`frontend/src/api/index.ts`）：401 → `window.location = "https://auth.cqu.moe/login?redirect=" + encodeURIComponent(location.href)`。
- 新 store `useSession`：拉 `/api/v2/me` → `user` + `caps`；暴露 `can(flag)`、`quota(key)`。
- 删除登录/注册/找回页面与路由、密码相关 API。
- Commit: `feat(fe): auth 跳转登录 + caps session store；删密码 UI`

### Task I2: Dashboard 订阅列表 + caps 门禁
- 列表走 `/api/v2/subscriptions`；"创建外部订阅"按钮按 `can('external')` 显隐；显示 `sub_limit` 用量。
- 创建/删除接 v2；mutation 成功 toast 在 reload 前发出（CLAUDE.md 约定）。
- Commit。

### Task I3: 链接管理 UI
- 每订阅展开链接列表：默认链接标"默认·不可删"；分享链接显示 formats 徽标。
- 新建分享链接对话框：`label` + 格式多选（ics/origin_json/data_json/csv/web）；按 `can('share')` 与 `share_limit` 用量门禁。
- 复制 URL、换 token（POST rotations）、删除（PATCH/DELETE）。
- Commit。

### Task I4: /view/:token 公开只读日历页
- 新路由 `/view/:token`（不需登录）：复用现有 FullCalendar 组件，数据取 `/api/v2/calendar/:token/view.json`；403/404 时显示友好提示。
- 注意 FullCalendar 时区/图标字体既有坑（CLAUDE.md）。
- Commit。

### Task I5: 前端测试补齐 + 构建验证
- 覆盖：caps 条件渲染、链接管理交互（含默认链接不可删）、view 页 403 提示。
- Run: `npm run test:frontend` + `cd frontend && npm run build` → 绿。
- Commit。

---

## Phase J — 收尾 / 部署前

### Task J1: 全量校验
- `npm run typecheck` → 绿
- `npx vitest run --exclude 'frontend/**'` → 绿
- `npm run test:frontend` → 绿
- `npm run build:frontend` → 绿
- Commit（如有）。

### Task J2: 部署前清单（写入 PR 描述，不在本地执行）
1. auth 侧确认已上线：RPC entrypoint、`calendar` client（skipConsent + subsystem + jwxt scope）、`capabilities.ts` 7 caps、跨子域 cookie、默认预设。
2. ⚠️ **服务 URL 对齐实测**（设计 §12.1）：真账号验证 `getCquTicket(jwxt)` 出的 ST 能被 `exchangeTicketForCquToken` 换到 bearer。
3. 部署后 `npx wrangler d1 migrations apply schedule-beta-cqu-moe-db --remote`（破坏性：drop 旧表）。
4. 确认生产 KV/queue 配置随 wrangler 更新（删 token-refresh 队列需在 CF 后台处理或忽略）。

---

## 任务依赖图

```
A1 → A2 → B1 → B2 → B3 → B4 → C1
                              ├→ D1 → D2 → D3
                              │         └→ E1 → E2 → E3 → E4 → E5 → E6
                              │                    └→ F1 → F2 → F3
                              └→ G1 → G2 → G3 → G4
D/E/F/G ─→ H1 → H2 → I1 → I2 → I3 → I4 → I5 → J1 → J2
```
