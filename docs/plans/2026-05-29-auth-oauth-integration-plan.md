# auth.cqu.moe OAuth 接入 — 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给 schedule 加一条「使用 auth.cqu.moe 登录」的第三方 OAuth 2.1 + OIDC 登录路径,与现有学号密码路径并存(账号按登录方式分离)。

**Architecture:** AUTH 只替换现有 `login()` 的「密码→ticket」段(第 1-2 步);拿到 auth 的 CAS service-ticket 后,复用 `auth.ts` 第 3-5 步(重构为 `exchangeTicketForCquToken`)换得 `my.cqu.edu.cn` bearer token,落到与密码账号完全相同的形态,下游 `CQUAPIClient`/`sync`/`explore`/ICS/限频/缓存全部不变。state/PKCE 用独立 key (`OAUTH_STATE_KEY`) 加密的 HttpOnly cookie 承载(不用 KV,因 KV 最终一致)。

**Tech Stack:** Cloudflare Workers + Hono + D1 + Drizzle ORM + Web Crypto(AES-256-GCM)+ Vue 3 SPA。后端测试 vitest v3 + @cloudflare/vitest-pool-workers;前端 vitest v4 + jsdom。

**设计依据:** 同目录 `2026-05-29-auth-oauth-integration-design.md`(已过 Codex gpt-5.5/xhigh 四轮审查,零 must-fix)。本计划的每个"为什么"都指回该设计文档对应小节,不重复论证。

**全局约束(每个 commit 都遵守):**
- 默认 git 身份(`User-Unauthorized`),禁止 `-c user.name/email` / `--author` 覆盖。
- 签名走 1Password SSH agent;若报 `failed to fill whole buffer`,临时 `-c commit.gpgsign=false`,待解锁后 `git rebase --exec 'git commit --amend --no-edit -S' HEAD~N` 补签。
- 后端测试:`npx vitest run --exclude 'frontend/**'`(`npx vitest run src/` 仍会拾取 frontend);前端:`npm run test:frontend`。
- 涉及第三方库用法先查 Context7;涉及 Cloudflare 先查 cloudflare-docs MCP。
- 提交信息用 Conventional Commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## 任务依赖与顺序

```
T1 常量/Env/secrets 脚手架
T2 schema + 迁移(加列、part-unique、encrypted_password 可空)
T3 OAuth 事务 cookie 助手(encode/decode + PKCE) ──┐
T4 auth.ts 重构 exchangeTicketForCquToken          ─┤
T5 auth.cqu.moe 客户端(token/userinfo/status/ticket) ┘
T6 routes/oauth.ts: GET /login
T7 routes/oauth.ts: GET /callback(含幂等 upsert + read-after-conflict + 错误矩阵)
T8 密码流按 auth_user_id IS NULL 收口(High 1 安全)
T9 token-refresh: AUTH 分支 + 失败三桶 + D8 轮换 + 并发守卫
T10 挂载路由到 index.ts
T11 前端: OAuthCallback.vue + 路由 + Login.vue 按钮
T12 文档: CLAUDE.md + Docs.vue
T13 上线序列: 远端迁移 apply + 三条 redirect_uri 登记(用户) + CASTGC live-ticket 实测
```

T3/T4/T5 互相独立,可并行;T6 依赖 T3+T5;T7 依赖 T2+T4+T5+T3;T9 依赖 T2+T4+T5。

---

## Task 1: 常量 / Env / secrets 脚手架

**Files:**
- Modify: `src/types.ts`(Env 接口)
- Create: `src/services/oauth-constants.ts`
- Modify: `.dev.vars`(本地 secrets,不入 git)

**Step 1: 加 Env 字段**

`src/types.ts` 的 `Env` 接口 Secrets 段加:

```ts
  // OAuth (auth.cqu.moe) secrets
  AUTH_OAUTH_CLIENT_ID: string;
  AUTH_OAUTH_CLIENT_SECRET: string;
  OAUTH_STATE_KEY: string; // base64, 独立于 ENCRYPTION_KEY(设计 §7.1)
```

**Step 2: 常量模块**

Create `src/services/oauth-constants.ts`:

```ts
export const AUTH_BASE = "https://auth.cqu.moe";
export const OAUTH_SCOPE = "openid offline_access cqu:ticket:jwxt";
export const OAUTH_TX_COOKIE = "oauth_tx";
export const OAUTH_TX_TTL_MS = 600_000; // 10 min,对齐 auth code 有效期
export const OAUTH_COOKIE_PATH = "/api/v1/auth/oauth";

/** 请求 host → SPA/redirect origin 的精确映射(设计 §4.1 High 2/Low3)。查不到 → null → 调用方返回 400 */
const HOST_ORIGIN_MAP: Record<string, string> = {
  "schedule.cqu.moe": "https://schedule.cqu.moe",
  "schedule-beta.cqu.moe": "https://schedule-beta.cqu.moe",
  "localhost:8787": "http://localhost:8787",
};

export function resolveOrigin(requestUrl: string): string | null {
  const host = new URL(requestUrl).host; // 精确 host(含端口),非子串
  return HOST_ORIGIN_MAP[host] ?? null;
}
```

**Step 3: 本地 secrets**

`.dev.vars` 增三行(值用占位/真实,1Password 流程在 T13 收口):

```
AUTH_OAUTH_CLIENT_ID="<dev client id>"
AUTH_OAUTH_CLIENT_SECRET="<dev client secret>"
OAUTH_STATE_KEY="<openssl rand -base64 32 的输出>"
```

**Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS(Env 新字段不破坏现有代码)。

**Step 5: 单测 resolveOrigin**

Create `src/services/oauth-constants.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveOrigin } from "./oauth-constants";

describe("resolveOrigin", () => {
  it("maps prod host", () => {
    expect(resolveOrigin("https://schedule.cqu.moe/api/v1/auth/oauth/login")).toBe("https://schedule.cqu.moe");
  });
  it("maps beta host", () => {
    expect(resolveOrigin("https://schedule-beta.cqu.moe/x")).toBe("https://schedule-beta.cqu.moe");
  });
  it("maps localhost to http", () => {
    expect(resolveOrigin("http://localhost:8787/x")).toBe("http://localhost:8787");
  });
  it("rejects unknown host (no substring match)", () => {
    expect(resolveOrigin("https://evil-schedule.cqu.moe.attacker.com/x")).toBeNull();
  });
});
```

Run: `npx vitest run src/services/oauth-constants.test.ts`
Expected: 4 PASS。

**Step 6: Commit**

```bash
git add src/types.ts src/services/oauth-constants.ts src/services/oauth-constants.test.ts
git commit -m "feat(oauth): add Env secrets, constants, host->origin resolver"
```

---

## Task 2: schema + 迁移

> 设计 §3 / §3.2。注意:`student_id` 唯一是独立索引(drop index 即可),真正整表重建来自 `encrypted_password` 可空化。

**Files:**
- Modify: `src/db/schema.ts`
- Generate: `drizzle/migrations/000X_*.sql`(drizzle-kit)
- Test: 本地 D1 PRAGMA 校验

**Step 1: 改 schema**

`src/db/schema.ts` 的 `users` 表:

```ts
  studentId: text("student_id").notNull(), // 去掉 .unique()(改为下方部分唯一索引)
  encryptedPassword: text("encrypted_password").notNull(), // D7: 保持 NOT NULL,AUTH 账号存哨兵 ""(绕开会级联删 subscriptions 的整表重建)
  authUserId: text("auth_user_id").unique(), // auth.cqu.moe 的 sub,不透明 base62
  authRefreshToken: text("auth_refresh_token"),
  authRefreshIssuedAt: text("auth_refresh_issued_at"), // ISO 8601
```

并在表的第二参数(索引数组)加部分唯一索引:

```ts
  uniqueIndex("uq_password_student_id").on(table.studentId).where(sql`auth_user_id IS NULL`),
```

`subscriptions` 表索引数组加(设计 §4.2 step9 Medium2 兜底):

```ts
  uniqueIndex("uq_personal_user_source").on(table.userId, table.sourceType).where(sql`is_personal = 1`),
```

**Step 2: 生成迁移**

Run: `npm run db:generate`
Expected: 新 migration SQL 只含:`ADD COLUMN auth_user_id/auth_refresh_token/auth_refresh_issued_at`、`DROP INDEX users_student_id_unique`、`CREATE UNIQUE INDEX users_auth_user_id_unique`、`CREATE UNIQUE INDEX uq_password_student_id ... WHERE auth_user_id IS NULL`、`uq_personal_user_source ... WHERE is_personal = 1`。**关键(D7):因 `encrypted_password` 保持 `NOT NULL`,迁移 _不应_ 出现整表重建(`CREATE TABLE __new_users` / `DROP TABLE users`)。若 drizzle-kit 仍生成了重建,STOP——它会在 D1 生产库经 `ON DELETE CASCADE` 删光 `subscriptions`(D1 迁移内关不掉外键,CF 文档证实)。**人工 review 确认无 `DROP TABLE`。

**Step 3: 本地应用**

Run: `npm run db:migrate:local`
Expected: 无错误。

**Step 4: PRAGMA 校验(设计 §3.2 step4)**

Run:
```bash
npx wrangler d1 execute schedule-beta-cqu-moe-db --local --command "PRAGMA index_list(users);"
npx wrangler d1 execute schedule-beta-cqu-moe-db --local --command "PRAGMA table_info(users);"
```
Expected: `users_student_id_unique` 不在列表;`uq_password_student_id` 在;`encrypted_password` 的 `notnull` 列**为 1**(D7 保持 NOT NULL);`calendar_token`/`auth_user_id` 唯一索引在。另外:先插一条 user + 一条 subscription 再 apply,`SELECT count(*) FROM subscriptions` 应 = 1(证明无 cascade)。

**Step 5: 跑现有后端测试确认无回归**

Run: `npx vitest run --exclude 'frontend/**'`
Expected: 现有用例全 PASS(注意 worktree/分支下若 `frontend/dist` 不存在需 `mkdir -p frontend/dist`)。

**Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/migrations/
git commit -m "feat(db): add auth account columns, partial-unique indexes, nullable password"
```

---

## Task 3: OAuth 事务 cookie 助手(state + PKCE)

> 设计 §4.1 / §7。复用现有 `crypto.ts` 的 `encrypt`/`decrypt`,传 `OAUTH_STATE_KEY`;IV 由现有 helper 随机生成,无需新增 crypto。

**Files:**
- Create: `src/services/oauth-tx.ts`
- Test: `src/services/oauth-tx.test.ts`

**Step 1: 写失败测试**

`src/services/oauth-tx.test.ts`(`TEST_KEY` 用 32 字节 base64):

```ts
import { describe, it, expect } from "vitest";
import { generatePkce, sealTx, openTx } from "./oauth-tx";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32))); // 全 0 仅测试用

describe("PKCE", () => {
  it("challenge is base64url SHA-256 of verifier", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toContain("="); expect(challenge).not.toContain("+"); expect(challenge).not.toContain("/");
  });
});

describe("tx cookie seal/open", () => {
  it("round-trips state+verifier+origin", async () => {
    const sealed = await sealTx({ state: "s1", verifier: "v1", origin: "https://schedule.cqu.moe" }, KEY, 1_000_000);
    const opened = await openTx(sealed, KEY, 5_000_000);
    expect(opened).toEqual({ state: "s1", verifier: "v1", origin: "https://schedule.cqu.moe" });
  });
  it("returns null when expired", async () => {
    const sealed = await sealTx({ state: "s", verifier: "v", origin: "o" }, KEY, 1_000);
    expect(await openTx(sealed, KEY, 2_000)).toBeNull(); // now=2000 > exp=1000
  });
  it("returns null on tamper / bad key", async () => {
    const sealed = await sealTx({ state: "s", verifier: "v", origin: "o" }, KEY, 9e15);
    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    expect(await openTx(sealed, otherKey, 0)).toBeNull();
  });
});
```

Run: `npx vitest run src/services/oauth-tx.test.ts`
Expected: FAIL(模块不存在)。

**Step 2: 实现**

`src/services/oauth-tx.ts`:

```ts
import { encrypt, decrypt } from "./crypto";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48))); // 64 chars
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function generateState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export interface OAuthTx { state: string; verifier: string; origin: string; }

/** exp 用绝对毫秒时间戳(由调用方用 Date.now()+TTL 传入,便于测试注入) */
export async function sealTx(tx: OAuthTx, keyBase64: string, expMs: number): Promise<string> {
  return encrypt(JSON.stringify({ ...tx, exp: expMs }), keyBase64);
}

export async function openTx(sealed: string, keyBase64: string, nowMs: number): Promise<OAuthTx | null> {
  try {
    const obj = JSON.parse(await decrypt(sealed, keyBase64)) as OAuthTx & { exp: number };
    if (typeof obj.exp !== "number" || nowMs > obj.exp) return null;
    return { state: obj.state, verifier: obj.verifier, origin: obj.origin };
  } catch {
    return null; // 解密失败 / 篡改 / 非法 JSON
  }
}
```

> 注:`encrypt/decrypt` 用单条 key 缓存(`crypto.ts:14`),OAuth 路径与 `ENCRYPTION_KEY` 交替会失效缓存;调用量极低,可忽略(设计 §7.2 备注)。

**Step 3: 跑测试**

Run: `npx vitest run src/services/oauth-tx.test.ts`
Expected: PASS。

**Step 4: Commit**

```bash
git add src/services/oauth-tx.ts src/services/oauth-tx.test.ts
git commit -m "feat(oauth): add PKCE + encrypted state-cookie tx helpers"
```

---

## Task 4: 重构 `auth.ts` 抽出 `exchangeTicketForCquToken`

> 设计 §4.3。把现有 `login()` 第 3-5 步(验 ticket→SESSION→authorize→code→换 token)抽成可复用纯函数;`login()` 行为不变。

**Files:**
- Modify: `src/services/auth.ts`
- Test: `src/services/auth.test.ts`(若不存在则创建)

**Step 1: 写测试(用 fetch mock 驱动第 3-5 步)**

新增 `exchangeTicketForCquToken` 的测试:mock `globalThis.fetch` 依次返回:(a) CAS 验证响应(`Set-Cookie: SESSION=...`),(b) authorize 302(`Location: ...?code=AUTHCODE`),(c) token JSON(`access_token`/`refresh_token`/`expires_in`)。断言返回 `{ accessToken, refreshToken, expiresAt }`。

```ts
// 关键断言
const r = await exchangeTicketForCquToken("ST-abc");
expect(r.accessToken).toBe("at-xyz");
expect(r.refreshToken).toBe("rt-xyz");
expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
```

Run: `npx vitest run src/services/auth.test.ts`
Expected: FAIL(函数未导出)。

**Step 2: 重构实现**

把 `login()` 中「Step 3: Validate CAS ticket … 」到「Step 5: Exchange code for tokens」整段移入新导出函数:

```ts
export async function exchangeTicketForCquToken(ticket: string, signal?: AbortSignal): Promise<TokenResult> {
  // Step 3: 验 ticket → SESSION(无需 CASTGC,见设计 §4.3 备注;实现期 T13 实测)
  // Step 4: OAuth authorize → code
  // Step 5: code 换 token
  // ……(原 login 第 3-5 步代码原样搬入,ticket 作入参)
}
```

`login()` 改为:自行走完第 1-2 步拿到 `ticket` 后 `return exchangeTicketForCquToken(ticket, controller.signal);`。

**Step 3: 跑测试(新函数 + 现有 login 不回归)**

Run: `npx vitest run src/services/auth.test.ts`
Expected: PASS;现有 login 相关用例仍 PASS。

**Step 4: Commit**

```bash
git add src/services/auth.ts src/services/auth.test.ts
git commit -m "refactor(auth): extract exchangeTicketForCquToken from login()"
```

---

## Task 5: auth.cqu.moe 客户端

> 设计 §4.2 步骤 4-7。封装对 auth 的四个调用,集中错误归类便于 T7/T9 复用。

**Files:**
- Create: `src/services/auth-oauth-client.ts`
- Test: `src/services/auth-oauth-client.test.ts`

**Step 1: 写失败测试(fetch mock)**

覆盖:`exchangeCode` 成功返回 `{access_token, refresh_token}`;`getUserInfo` 返回 `sub`;`getCquStatus` 返回 `{status, studentId}`;`getServiceTicket` 解析 JSON `{ ticket }`(设计 Nit:不是 `{ticket, service}`);各函数在 4xx/403 时抛带 code 的错误(供 T9 分类:`invalid_grant`/`invalid_client`/`invalid_scope`/403)。

Run: `npx vitest run src/services/auth-oauth-client.test.ts`
Expected: FAIL。

**Step 2: 实现**

`src/services/auth-oauth-client.ts`(要点):

```ts
import { AUTH_BASE, OAUTH_SCOPE } from "./oauth-constants";

export class AuthOAuthError extends Error {
  constructor(public code: string, message: string, public permanentKind: "user" | "operator" | "transient") {
    super(message); this.name = "AuthOAuthError";
  }
}

export async function exchangeCode(env, code, redirectUri, verifier): Promise<{ access_token: string; refresh_token: string; }> { /* POST oauth2/token grant_type=authorization_code */ }
export async function refreshAuthToken(env, refreshToken): Promise<{ access_token: string; refresh_token: string; }> { /* POST oauth2/token grant_type=refresh_token;映射 invalid_grant→user / invalid_client|invalid_scope→operator / 5xx|网络→transient */ }
export async function getUserInfo(accessToken): Promise<{ sub: string }> { /* GET oauth2/userinfo */ }
export async function getCquStatus(accessToken): Promise<{ status: "unbound" | "active" | "expired" | "error"; studentId?: string }> { /* GET /api/cqu/status */ }
export async function getServiceTicket(accessToken): Promise<string> {
  const r = await fetch(`${AUTH_BASE}/api/cqu/service-ticket?service=jwxt`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (r.status === 403) throw new AuthOAuthError("scope_forbidden", "missing cqu:ticket:jwxt", "operator");
  if (!r.ok) throw new AuthOAuthError("ticket_failed", `HTTP ${r.status}`, "transient");
  const j = await r.json() as { ticket?: string };
  if (!j.ticket) throw new AuthOAuthError("ticket_failed", "no ticket in response", "transient");
  return j.ticket;
}
```

**Step 3: 跑测试**

Run: `npx vitest run src/services/auth-oauth-client.test.ts`
Expected: PASS。

**Step 4: Commit**

```bash
git add src/services/auth-oauth-client.ts src/services/auth-oauth-client.test.ts
git commit -m "feat(oauth): add auth.cqu.moe client (token/userinfo/status/ticket)"
```

---

## Task 6: `GET /api/v1/auth/oauth/login`

> 设计 §4.1。

**Files:**
- Create: `src/routes/oauth.ts`
- Test: `src/routes/oauth.test.ts`

**Step 1: 写失败测试**

```ts
// 在 prod host 发起:302 到 auth authorize,Set-Cookie oauth_tx 带 HttpOnly/SameSite=Lax/Path=/api/v1/auth/oauth
// 在 beta host 发起:redirect_uri 与 cookie 都用 beta origin
// 非白名单 host:400
```

断言 `Location` 含 `client_id`、`code_challenge_method=S256`、`redirect_uri=<origin>/api/v1/auth/oauth/callback`、`scope` 编码正确;`Set-Cookie` 含 `oauth_tx=`、`HttpOnly`、`SameSite=Lax`、`Path=/api/v1/auth/oauth`、`Max-Age=600`。

Run: `npx vitest run src/routes/oauth.test.ts`
Expected: FAIL。

**Step 2: 实现 /login**

```ts
app.get("/login", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const origin = resolveOrigin(c.req.url);
  if (!origin) return errorResponse("BAD_REQUEST", "unsupported host", 400);
  const { verifier, challenge } = await generatePkce();
  const state = generateState();
  const sealed = await sealTx({ state, verifier, origin }, c.env.OAUTH_STATE_KEY, Date.now() + OAUTH_TX_TTL_MS);
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  c.header("Set-Cookie", `${OAUTH_TX_COOKIE}=${sealed}; HttpOnly${secure}; SameSite=Lax; Path=${OAUTH_COOKIE_PATH}; Max-Age=600`);
  const u = new URL(`${AUTH_BASE}/api/auth/oauth2/authorize`);
  u.searchParams.set("client_id", c.env.AUTH_OAUTH_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${origin}/api/v1/auth/oauth/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", OAUTH_SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return c.redirect(u.toString(), 302);
});
```

**Step 3: 跑测试** — Run: `npx vitest run src/routes/oauth.test.ts` Expected: PASS。

**Step 4: Commit**

```bash
git add src/routes/oauth.ts src/routes/oauth.test.ts
git commit -m "feat(oauth): add GET /login (PKCE + state cookie + host-aware redirect)"
```

---

## Task 7: `GET /api/v1/auth/oauth/callback`

> 设计 §4.2(全部 10 步 + 错误矩阵 §9 + 幂等 upsert + read-after-conflict)。这是最大任务,按子步分多次 commit。

**Files:**
- Modify: `src/routes/oauth.ts`
- Modify: `src/routes/oauth.test.ts`

整个 handler **try/catch 包裹**,未预期异常 → `redirectErr(origin, "internal")`;所有错误跳 `${origin}/auth/callback#error=<code>`(origin 由回调请求 host 推导,见设计 §4.2 顶部)。

**Step 1: 错误前置 + cookie 校验(子任务 7a)**

测试:`?error=access_denied` → `#error=access_denied`;缺 `code`/`state` → `#error=oauth_missing_code`;无 cookie → `#error=oauth_state`;cookie.origin≠回调 host → `#error=oauth_state`;state 不符 → `#error=oauth_state`(timing-safe 比较)。实现 step 0-3,清 cookie。
Commit: `feat(oauth): callback param/cookie/state validation`

**Step 2: token 交换 + userinfo + status 细分(子任务 7b)**

测试:token 交换失败 → `#error=oauth_token`;status `unbound`/缺 studentId → `#error=cqu_unbound`;status `expired`/`error`(带 studentId)→ `#error=cqu_ticket`(设计 Round3/4 Low)。实现 step 4-6。
Commit: `feat(oauth): callback token exchange + cqu status classification`

**Step 3: 签 ticket + 换 CQU bearer(子任务 7c)**

测试:service-ticket 403 → `#error=cqu_ticket`;`exchangeTicketForCquToken` 失败 → `#error=cqu_login`。实现 step 7-8(调 T5 的 `getServiceTicket` + T4 的 `exchangeTicketForCquToken`)。
Commit: `feat(oauth): callback mint CQU bearer via service-ticket`

**Step 4: 幂等 upsert + read-after-conflict(子任务 7d,设计 §4.2 step9)**

测试(关键并发/幂等):
- 新用户:建 1 行 + 3 个个人订阅 + 触发后台同步(spy `syncNewUserSubscriptions`)+ 跳转带新 `calendar_token`。
- 已存在(同 sub):**不建订阅、不触发同步**;走 read-after-conflict `SELECT id, calendarToken`;更新 tokens + `auth_refresh_issued_at` + `studentId`;若 studentId 变则 `UPDATE subscriptions SET source_id`;跳转用 SELECT 到的 `calendar_token`。
- 并发两次同 sub:只建一组订阅、只触发一次同步(用 `ON CONFLICT(auth_user_id) DO NOTHING RETURNING id`,仅返回行的那次建订阅)。

实现 step 9:

```ts
const inserted = await db.insert(users).values({ authUserId: sub, studentId, encryptedPassword: null,
  accessToken: encAt, refreshToken: encRt, tokenExpiresAt, authRefreshToken: encAuthRt,
  authRefreshIssuedAt: now, calendarToken: generateToken(), createdAt: now, updatedAt: now })
  .onConflictDoNothing({ target: users.authUserId })
  .returning({ id: users.id, calendarToken: users.calendarToken });

let userId: string, calendarToken: string;
if (inserted.length) {
  ({ id: userId, calendarToken } = inserted[0]);
  // 建 3 个个人订阅 + waitUntil(syncNewUserSubscriptions(...))  ← 仅此路径
} else {
  const [ex] = await db.select({ id: users.id, calendarToken: users.calendarToken })
    .from(users).where(eq(users.authUserId, sub)).limit(1); // read-after-conflict(设计 Round3 M2)
  userId = ex.id; calendarToken = ex.calendarToken;
  await db.update(users).set({ accessToken: encAt, refreshToken: encRt, tokenExpiresAt,
    authRefreshToken: encAuthRt, authRefreshIssuedAt: now, studentId, lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, userId));
  await db.update(subscriptions).set({ sourceId: studentId, updatedAt: now })
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.isPersonal, true)));
}
return c.redirect(`${origin}/auth/callback#token=${calendarToken}`, 302);
```

Commit: `feat(oauth): idempotent account upsert with read-after-conflict`

**Step 5: 全量跑** — Run: `npx vitest run src/routes/oauth.test.ts` Expected: 全 PASS。

---

## Task 8: 密码流按 `auth_user_id IS NULL` 收口(High 1 安全)

> 设计 §3.1。`student_id` 不再全局唯一后,密码注册/恢复必须排除 AUTH 行。

**Files:**
- Modify: `src/routes/users.ts`(`:97` 注册存在性查询、`:206` recover、`:244` recover/verify)
- Test: `src/routes/users.test.ts`(若无则建)

**Step 1: 写失败测试**

- 库中已有「同 studentId 的 AUTH 行(encrypted_password=null)」时:
  - 密码注册同 studentId → 不更新该 AUTH 行,而是新建/更新**密码账号**行(返回的 calendar_token ≠ AUTH 行的)。
  - recover/recover-verify 同 studentId → 不命中 AUTH 行(不会拿 null 密码进 verifyPassword)。

Run: `npx vitest run src/routes/users.test.ts`
Expected: FAIL(当前按 studentId 单条件命中 AUTH 行)。

**Step 2: 实现**

把 `users.ts` 三处 `where(eq(users.studentId, student_id))` 改为 `where(and(eq(users.studentId, student_id), isNull(users.authUserId)))`(import `and`, `isNull`)。

**Step 3: 跑测试** — Run: `npx vitest run src/routes/users.test.ts` Expected: PASS;现有注册/恢复用例不回归。

**Step 4: Commit**

```bash
git add src/routes/users.ts src/routes/users.test.ts
git commit -m "fix(users): scope password register/recover to non-auth accounts"
```

---

## Task 9: token-refresh — AUTH 分支 + 失败三桶 + D8 + 并发守卫

> 设计 §5(全部)。最复杂的并发逻辑,务必对照设计 §5 三条守卫。

**Files:**
- Modify: `src/cron/token-refresh.ts`
- Test: `src/cron/token-refresh.test.ts`

**Step 1: 写失败测试**

- consumer SELECT 增 `authUserId`/`authRefreshToken`/`authRefreshIssuedAt`。
- **密码账号**:行为不变(回归)。
- **AUTH 账号**:CQU refresh 成功 → 更新 CQU token;若 `auth_refresh_issued_at` >25 天 → 额外 auth 轮换并更新 issued_at。
- **早退门(Round3 M1)**:CQU 不再 stale **且** auth 不需轮换 → ack;CQU 新鲜但 auth stale → 只做 auth 轮换。
- **CQU refresh 失败兜底**:解密 authRefreshToken → refreshAuthToken → getServiceTicket → exchangeTicketForCquToken → 新 CQU token。
- **失败三桶**:`invalid_grant`(经重读确认仍 stale)→ user-permanent ack;`invalid_client`/`invalid_scope`→ operator-permanent ack+告警日志;5xx/超时 → retry。
- **良性竞态(Round2 M1)**:auth `invalid_grant` 但重读发现 `auth_refresh_issued_at` 已被另一条投递更新 → ack,不判永久。
- **先持久化 CQU,再轮换**:轮换失败不回滚已写入的 CQU token。

Run: `npx vitest run src/cron/token-refresh.test.ts`
Expected: FAIL。

**Step 2: 实现**

在 `processTokenRefreshBatch` 的 per-message 逻辑里:复用现有「重读最新 user + recheck」骨架(`token-refresh.ts:53-74`),把 recheck 扩成 `needsCquRefresh || needsAuthRotation`;按设计 §5 写 AUTH 分支与三桶分类。`needsAuthRotation = authUserId && authRefreshIssuedAt 且 (now - issuedAt) > 25d`。auth `invalid_grant` 处理:`re-read user; if user.authRefreshIssuedAt !== 本次读到的值 → ack(良性)`。

**Step 3: 跑测试** — Run: `npx vitest run src/cron/token-refresh.test.ts` Expected: 全 PASS。

**Step 4: Commit**

```bash
git add src/cron/token-refresh.ts src/cron/token-refresh.test.ts
git commit -m "feat(cron): AUTH-account refresh with taxonomy, D8 rotation, race guards"
```

---

## Task 10: 挂载路由

**Files:** Modify `src/index.ts`

**Step 1:** import 并挂载 `app.route("/api/v1/auth/oauth", oauthApp)`(注意 Hono 静态路径先于参数路径;放在合适位置)。
**Step 2:** Run `npm run typecheck` + `npx vitest run --exclude 'frontend/**'` Expected: PASS。
**Step 3:** Commit `feat(oauth): mount oauth routes at /api/v1/auth/oauth`

---

## Task 11: 前端

> 设计 §8。

**Files:**
- Create: `frontend/src/views/OAuthCallback.vue`
- Modify: `frontend/src/router/index.ts`(加 `/auth/callback` + `RouteNames.OAuthCallback`)
- Modify: `frontend/src/views/Login.vue`(加按钮)
- Test: `frontend/src/views/__tests__/OAuthCallback.spec.ts`、Login 测试补按钮断言

**Step 1: OAuthCallback 测试(失败)**

mount 时:`location.hash = "#token=abc"` → 调 `authStore.loginWithToken('abc')` → `history.replaceState` 抹 hash → `router.push(dashboard)`;`#error=cqu_unbound` → 显示对应中文文案(含 auth 绑定链接);其余 error code → 各自文案。
Run: `npm run test:frontend`
Expected: FAIL。

**Step 2: 实现 OAuthCallback.vue**(`<script setup lang="ts">`,onMounted 解析 hash;error 文案映射对照设计 §9 表;成功走现有 `loginWithToken`)。

**Step 3: 路由 + Login 按钮**

router 加 `{ path: '/auth/callback', name: RouteNames.OAuthCallback, component: () => import('@/views/OAuthCallback.vue') }`;Login.vue 加按钮 `window.location.href = '/api/v1/auth/oauth/login'`,保留 token 表单。

**Step 4: 跑前端测试 + 构建** — Run: `npm run test:frontend` 然后 `cd frontend && npm run build` Expected: PASS / 构建成功。

**Step 5: Commit** `feat(frontend): auth.cqu.moe login button + OAuth callback view`

---

## Task 12: 文档

**Files:** Modify `CLAUDE.md`(新增 OAuth 链路、新 secrets、host→origin、迁移注意)、`frontend/src/views/Docs.vue`(若对外暴露登录方式)。
Commit: `docs: document auth.cqu.moe OAuth integration`

---

## Task 13: 上线序列(人工 + 实测)

> 不是代码任务,是 checklist。**这些必须在合并/上线时按序执行。**

1. **用户在 auth.cqu.moe 侧**:注册本 client(拿 `client_id`/`client_secret`)、授予 `cqu:ticket:jwxt` scope(`oauth_client_cqu_scopes`)、登记三条 redirect_uri(prod/beta/localhost)。
2. **推 secrets**:`OAUTH_STATE_KEY`(`openssl rand -base64 32`)、`AUTH_OAUTH_CLIENT_ID`、`AUTH_OAUTH_CLIENT_SECRET` 经 `npm run deploy:secrets`(1Password)推到 Cloudflare。
3. **远端迁移**(设计 §3.2 红线):`npx wrangler d1 migrations apply schedule-beta-cqu-moe-db --remote`,随后远端 `PRAGMA` 校验。**必须在部署新代码后、依赖新列的路径被调用前完成**,否则 `.returning()` 报 `no such column`。
4. **CASTGC-less live-ticket 实测(设计 §13.1,唯一真未知)**:用真实 auth 账号走一遍 `/login`→授权→`/callback`,`wrangler tail` 观察 `exchangeTicketForCquToken` 是否在无 CASTGC 下成功取得 SESSION 并换到 CQU token。**若失败**,回到 T4 评估是否需在 ticket 验证步带额外 cookie/参数。
5. 冒烟:新账号登录建订阅、ICS 可订阅;改绑后重新登录 source_id 刷新;token 刷新 cron 对 AUTH 账号正常。

---

## 验收标准(整体)

- `npx vitest run --exclude 'frontend/**'` 与 `npm run test:frontend` 全绿;`npm run typecheck` 通过;`cd frontend && npm run build` 成功。
- 两条登录路径都可用,互不串号(High 1 测试覆盖)。
- beta 域名登录不丢 cookie(High 2)。
- AUTH 账号 token 刷新、D8 轮换、并发守卫按 §5 行为(T9 测试覆盖)。
- T13 CASTGC live-ticket 实测通过。
