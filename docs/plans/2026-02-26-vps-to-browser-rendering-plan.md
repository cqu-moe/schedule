# VPS → CF Browser Rendering 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 CF Browser Rendering 替换 VPS Playwright 服务，实现全 CF 原生部署。

**Architecture:** `@cloudflare/playwright` 在 Worker 内直接启动无头浏览器完成 CQU SSO 登录。Token refresh 改为 Worker 内直接 fetch CQU OAuth 端点。删除 VPS 相关的 worker-client、env 变量和基础设施配置。

**Tech Stack:** @cloudflare/playwright, Cloudflare Browser Rendering, Hono, Drizzle ORM

---

### Task 1: 安装依赖并配置 binding

**Files:**
- Modify: `package.json`
- Modify: `wrangler.jsonc`

**Step 1: 安装 @cloudflare/playwright**

Run: `cd /Users/uu/Documents/Coding/cqu-moe/schedule-cloudflare && npm install @cloudflare/playwright`

**Step 2: 在 wrangler.jsonc 添加 browser binding**

在 `wrangler.jsonc` 的 `ratelimits` 之后添加：

```jsonc
// Browser Rendering
"browser": {
  "binding": "MYBROWSER"
},
```

**Step 3: 验证配置**

Run: `npm run typecheck`
Expected: 可能报错（MYBROWSER 还没加到 Env），暂时忽略

**Step 4: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc
git commit -m "chore: add @cloudflare/playwright and browser binding"
```

---

### Task 2: 更新 Env 类型

**Files:**
- Modify: `src/types.ts:1-27`

**Step 1: 更新 Env 接口**

将 `src/types.ts` 替换为：

```typescript
import type { BrowserWorker } from "@cloudflare/playwright";

export interface Env {
  // Static Assets
  ASSETS: Fetcher;

  // D1 Database
  DB: D1Database;

  // Browser Rendering
  MYBROWSER: BrowserWorker;

  // Rate Limiting
  UNAUTH_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  EXPLORE_LIMITER: RateLimit;

  // Secrets
  ENCRYPTION_KEY: string;
  HCAPTCHA_SECRET: string;

  // Environment Variables
  PUBLIC_URL: string;
  HCAPTCHA_ENABLED: string;
  HCAPTCHA_SITEKEY: string;
  MAX_SUBSCRIPTIONS: string;
  GIT_COMMIT: string;
  GIT_DATE: string;
}
```

变更点：
- 新增 `import type { BrowserWorker }`
- 新增 `MYBROWSER: BrowserWorker`
- 删除 `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `PLAYWRIGHT_URL`

**Step 2: Run typecheck 查看所有受影响的引用**

Run: `npm run typecheck`
Expected: 报错在 `worker-client.ts`（引用已删除的 env 字段），暂时预期

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: update Env type for Browser Rendering, remove VPS vars"
```

---

### Task 3: 创建 auth.ts — refreshToken 函数

**Files:**
- Create: `src/services/auth.ts`

**Step 1: 创建 auth.ts 文件，先实现 refreshToken**

refreshToken 是纯 HTTP 调用，不依赖浏览器，先实现它。

```typescript
import { launch, type BrowserWorker } from "@cloudflare/playwright";

// Constants
const LOGIN_URL = "https://sso.cqu.edu.cn/login";
const SUCCESS_URL_PATTERN = "self.cqu.edu.cn/cas-success";
const WORKSPACE_URL = "https://my.cqu.edu.cn/workspace/home";
const FALLBACK_URL = "https://my.cqu.edu.cn/enroll";
const TOKEN_REFRESH_URL = "https://my.cqu.edu.cn/authserver/oauth/token";
const OAUTH_CLIENT_ID = "personal-prod";
const OAUTH_CLIENT_SECRET = "app-a-1234";

const TOKEN_KEY = "cqu_edu_ACCESS_TOKEN";
const REFRESH_TOKEN_KEY = "cqu_edu_REFRESH_TOKEN";

const USERNAME_SELECTOR = "input[placeholder*='统一身份认证号']";
const PASSWORD_SELECTOR = "input[type='password']:visible";
const LOGIN_BUTTON_SELECTOR = ".login-button";

const LOGIN_TIMEOUT_MS = 55_000; // CF Browser Rendering 硬限制 60s，留 5s 余量
const ANGULAR_RENDER_WAIT = 2_000;
const BUTTON_CLICK_WAIT = 500;
const RETRY_WAIT = 1_000;
const MAX_TOKEN_RETRIES = 5;
const TOKEN_EXPIRY_HOURS = 4;

export class AuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
}

export async function refreshToken(refreshTokenStr: string): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetch(TOKEN_REFRESH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshTokenStr,
      }),
    });
  } catch (e) {
    throw new AuthError("UPSTREAM_UNREACHABLE", `Network error: ${e}`);
  }

  if (!response.ok) {
    const code = response.status === 401 ? "TOKEN_EXPIRED" : "UPSTREAM_UNREACHABLE";
    throw new AuthError(code, `Token refresh failed: HTTP ${response.status}`);
  }

  const data: any = await response.json();
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new AuthError("UPSTREAM_UNREACHABLE", "No access_token in refresh response");
  }

  const expiresIn = data.expires_in ?? TOKEN_EXPIRY_HOURS * 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  return {
    accessToken,
    refreshToken: data.refresh_token ?? refreshTokenStr,
    expiresAt,
  };
}
```

注意：login 函数在 Task 4 添加，此处先留 placeholder 注释 `// login() — see Task 4`。

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: 仍有 worker-client.ts 的错误（预期），但 auth.ts 本身无错误

**Step 3: Commit**

```bash
git add src/services/auth.ts
git commit -m "feat: add auth.ts with refreshToken (direct HTTP)"
```

---

### Task 4: 创建 auth.ts — login 函数

**Files:**
- Modify: `src/services/auth.ts`

**Step 1: 在 auth.ts 底部添加 login 函数**

在 `refreshToken` 函数之后添加：

```typescript
export async function login(
  browser: BrowserWorker,
  username: string,
  password: string,
): Promise<TokenResult> {
  const instance = await launch(browser);
  try {
    const page = await instance.newPage();

    // Navigate to SSO login page
    await page.goto(LOGIN_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(ANGULAR_RENDER_WAIT);

    // Fill credentials
    await page.fill(USERNAME_SELECTOR, username);
    await page.fill(PASSWORD_SELECTOR, password);
    await page.waitForTimeout(BUTTON_CLICK_WAIT);

    // Click login
    await page.click(LOGIN_BUTTON_SELECTOR);

    // Wait for CAS redirect
    try {
      await page.waitForURL(`**/${SUCCESS_URL_PATTERN}**`, {
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch {
      // Check for error message on page
      const errorElem = page.locator(".error-message, .ant-message, .alert").first();
      if (await errorElem.isVisible().catch(() => false)) {
        const errorText = await errorElem.textContent();
        if (errorText) {
          throw new AuthError("INVALID_CREDENTIALS", `Login failed: ${errorText}`);
        }
      }
      throw new AuthError("UPSTREAM_TIMEOUT", `Login timeout, URL: ${page.url()}`);
    }

    // Navigate to workspace to get tokens from localStorage
    await page.goto(WORKSPACE_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(ANGULAR_RENDER_WAIT);

    // Extract tokens with retry
    let accessToken = await getLocalStorageItem(page, TOKEN_KEY);
    let refreshTokenValue = await getLocalStorageItem(page, REFRESH_TOKEN_KEY);

    if (!accessToken) {
      for (let i = 0; i < MAX_TOKEN_RETRIES; i++) {
        await page.waitForTimeout(RETRY_WAIT);
        accessToken = await getLocalStorageItem(page, TOKEN_KEY);
        if (accessToken) {
          refreshTokenValue = await getLocalStorageItem(page, REFRESH_TOKEN_KEY);
          break;
        }
      }
    }

    // Fallback URL
    if (!accessToken) {
      await page.goto(FALLBACK_URL);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(ANGULAR_RENDER_WAIT);
      accessToken = await getLocalStorageItem(page, TOKEN_KEY);
      refreshTokenValue = await getLocalStorageItem(page, REFRESH_TOKEN_KEY);
    }

    if (!accessToken) {
      throw new AuthError("BROWSER_ERROR", "Unable to retrieve access token");
    }

    const expiresAt = new Date(
      Date.now() + TOKEN_EXPIRY_HOURS * 3600 * 1000,
    ).toISOString();

    return {
      accessToken,
      refreshToken: refreshTokenValue ?? "",
      expiresAt,
    };
  } finally {
    await instance.close();
  }
}

async function getLocalStorageItem(
  page: { evaluate: (fn: string) => Promise<unknown> },
  key: string,
): Promise<string | null> {
  const value = await page.evaluate(`localStorage.getItem('${key}')`);
  if (typeof value === "string") {
    return value.replace(/^"|"$/g, "");
  }
  return null;
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: auth.ts 无错误；worker-client.ts 仍有预期错误

**Step 3: Commit**

```bash
git add src/services/auth.ts
git commit -m "feat: add login via CF Browser Rendering"
```

---

### Task 5: 更新 users.ts 路由

**Files:**
- Modify: `src/routes/users.ts:7,21-26,66,225`

**Step 1: 更新 import**

将第 7 行：
```typescript
import { login, WorkerError } from "../services/worker-client";
```
改为：
```typescript
import { login, AuthError } from "../services/auth";
```

**Step 2: 更新 handleWorkerError → handleAuthError**

将第 21-26 行：
```typescript
function handleWorkerError(e: WorkerError): Response {
  if (e.code === "INVALID_CREDENTIALS") {
    return errorResponse("INVALID_CREDENTIALS", e.message, 401);
  }
  return errorResponse("UPSTREAM_ERROR", e.message, 502);
}
```
改为：
```typescript
function handleAuthError(e: AuthError): Response {
  if (e.code === "INVALID_CREDENTIALS") {
    return errorResponse("INVALID_CREDENTIALS", e.message, 401);
  }
  return errorResponse("UPSTREAM_ERROR", e.message, 502);
}
```

**Step 3: 更新 register 路由中的 login 调用（第 66 行附近）**

将：
```typescript
    tokenResult = await login(c.env, body.student_id, body.password);
  } catch (e) {
    if (e instanceof WorkerError) return handleWorkerError(e);
```
改为：
```typescript
    tokenResult = await login(c.env.MYBROWSER, body.student_id, body.password);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError(e);
```

**Step 4: 更新 recover/verify 路由中的 login 调用（第 225 行附近）**

将：
```typescript
    tokenResult = await login(c.env, body.student_id, body.password);
  } catch (e) {
    if (e instanceof WorkerError) return handleWorkerError(e);
```
改为：
```typescript
    tokenResult = await login(c.env.MYBROWSER, body.student_id, body.password);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError(e);
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: users.ts 无错误

**Step 6: Commit**

```bash
git add src/routes/users.ts
git commit -m "refactor: users.ts use auth.ts instead of worker-client"
```

---

### Task 6: 更新 token-refresh.ts

**Files:**
- Modify: `src/cron/token-refresh.ts:6-10,32,48,62`

**Step 1: 更新 import**

将第 6-10 行：
```typescript
import {
  refreshToken,
  login,
  WorkerError,
} from "../services/worker-client";
```
改为：
```typescript
import { refreshToken, login, AuthError } from "../services/auth";
```

**Step 2: 更新 refreshToken 调用（第 32 行）**

将：
```typescript
          const result = await refreshToken(env, user.refreshToken);
```
改为：
```typescript
          const result = await refreshToken(user.refreshToken);
```

**Step 3: 更新 WorkerError 检查（第 48 行）**

将：
```typescript
          if (!(e instanceof WorkerError) || (e.code !== "TOKEN_EXPIRED" && e.code !== "INVALID_TOKEN")) {
```
改为：
```typescript
          if (!(e instanceof AuthError) || (e.code !== "TOKEN_EXPIRED" && e.code !== "INVALID_TOKEN")) {
```

**Step 4: 更新 login 调用（第 62 行）**

将：
```typescript
      const result = await login(env, user.studentId, password);
```
改为：
```typescript
      const result = await login(env.MYBROWSER, user.studentId, password);
```

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS（零错误）

**Step 6: Commit**

```bash
git add src/cron/token-refresh.ts
git commit -m "refactor: token-refresh use auth.ts instead of worker-client"
```

---

### Task 7: 删除 worker-client.ts 并最终验证

**Files:**
- Delete: `src/services/worker-client.ts`

**Step 1: 确认无其他引用**

Run: `grep -r "worker-client" src/`
Expected: 无输出

**Step 2: 删除文件**

Run: `rm src/services/worker-client.ts`

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS（零错误）

**Step 4: Run 全部测试**

Run: `npm test`
Expected: 30 tests PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove worker-client.ts (VPS no longer needed)"
```

---

### Task 8: 更新项目文档

**Files:**
- Modify: `CLAUDE.md`

**Step 1: 更新 CLAUDE.md**

移除 VPS 相关描述，更新技术栈和项目结构说明：
- 删除 "VPS: 仅 Playwright 登录服务，通过 CF Tunnel + Access 访问"
- 添加 "Browser Rendering: @cloudflare/playwright 用于 CQU SSO 登录"
- `src/services/` 描述中 `worker-client` → `auth` (Playwright 登录 + OAuth token refresh)

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Browser Rendering migration"
```
