# VPS → CF Browser Rendering 迁移设计

## 目标

去掉 VPS，将 Playwright 登录功能迁移到 Cloudflare Browser Rendering，实现全 CF 原生部署。

## 背景

当前 VPS 唯一职责是运行 Playwright 无头浏览器完成 CQU SSO 登录。CF Browser Rendering 提供 `@cloudflare/playwright`，API 与标准 Playwright 几乎一致，可以直接在 Worker 中启动浏览器。

定价：Workers Paid 每月 10 小时免费浏览器时长，超出 $0.09/小时。实际用量（假设每月 100 次登录 × 30 秒）约 0.83 小时，远在免费额度内。

## 架构变更

### 之前

```
CF Worker → fetch (CF Access + Tunnel) → VPS:8000 (Playwright FastAPI)
```

### 之后

```
CF Worker → @cloudflare/playwright → CF Browser Rendering (内置)
```

## 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/services/worker-client.ts` | 删除 | 不再需要 VPS HTTP 客户端 |
| `src/services/auth.ts` | 新建 | login (Playwright) + refreshToken (直接 fetch) |
| `src/types.ts` | 修改 | 删除 `PLAYWRIGHT_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`；新增 `MYBROWSER: BrowserWorker` |
| `wrangler.jsonc` | 修改 | 新增 `browser.binding` |
| `src/routes/users.ts` | 修改 | 更新 import，调整 login/refresh 调用签名 |
| `src/cron/token-refresh.ts` | 修改 | 更新 import，refresh 直接调用不再经 VPS |
| 相关测试 | 修改 | mock `@cloudflare/playwright` |

## auth.ts 核心逻辑

### login(browser: BrowserWorker, username: string, password: string): Promise\<TokenResult\>

1:1 翻译自 Python 版 `login_with_playwright`：

1. `launch(browser)` 启动浏览器
2. `goto("https://sso.cqu.edu.cn/login")` + 等待 domcontentloaded + networkidle + 2s
3. 填写 `input[placeholder*='统一身份认证号']` 和 `input[type='password']:visible`
4. 点击 `.login-button`
5. `waitForURL("**/self.cqu.edu.cn/cas-success**")` 超时 55 秒（CF 硬限制 60 秒）
6. `goto("https://my.cqu.edu.cn/workspace/home")` + 等待加载
7. 从 localStorage 提取 `cqu_edu_ACCESS_TOKEN` / `cqu_edu_REFRESH_TOKEN`
8. 提取失败重试 5 次（每次 1 秒），仍失败跳 fallback URL `https://my.cqu.edu.cn/enroll`
9. `browser.close()`

错误码：`INVALID_CREDENTIALS` / `UPSTREAM_TIMEOUT` / `BROWSER_ERROR`

### refreshToken(refreshTokenStr: string): Promise\<TokenResult\>

直接 `fetch` CQU OAuth 端点（纯 HTTP，不需要浏览器）：

```
POST https://my.cqu.edu.cn/authserver/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=personal-prod
client_secret=app-a-1234
grant_type=refresh_token
refresh_token=<token>
```

错误码：`TOKEN_EXPIRED` / `UPSTREAM_UNREACHABLE`

## 保留不变

- `WorkerError` 类和错误码体系
- `TokenResult` 接口 (`accessToken`, `refreshToken`, `expiresAt`)
- 所有其他服务、路由、前端代码

## 配置变更

### wrangler.jsonc 新增

```jsonc
"browser": {
  "binding": "MYBROWSER"
}
```

### 依赖新增

```
npm install @cloudflare/playwright
```

### 删除的基础设施

- VPS 上的 Playwright FastAPI 服务
- CF Tunnel 到 VPS 的连接
- CF Access Policy 和 Service Token
- Workers Secrets: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`
- Workers 环境变量: `PLAYWRIGHT_URL`

## 测试策略

- `auth.ts` 单测 mock `@cloudflare/playwright` 的 `launch`（vitest + workerd 环境无法真正启动浏览器）
- 集成测试在 staging 环境手动验证完整登录流程
- 现有 30 个测试中涉及 `worker-client` 的需要更新 mock 目标
