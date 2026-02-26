# 设计文档：纯 HTTP 登录替换 Browser Rendering

## 背景

当前 `src/services/auth.ts` 的 `login()` 使用 `@cloudflare/playwright` (Browser Rendering) 完成 CQU SSO 登录：启动浏览器 → 填写表单 → 等待重定向 → 从 localStorage 提取 token。

SSO 登录流程已被逆向为纯 HTTP 请求（见 `cqu-api-endpoint-collection/systems/auth/` 和 `jwxt/`），可以完全替换浏览器方案。

## 方案

完全移除 Playwright/Browser Rendering，`login()` 改为纯 HTTP 实现。

## 收益

- 速度：5 个 HTTP 请求 vs 启动浏览器 + Angular 渲染 + 模拟点击
- 可靠性：不依赖 DOM 选择器、页面加载时序
- 成本：去掉 Browser Rendering 额度消耗
- 简洁：代码量更小，无 `@cloudflare/playwright` 依赖

## login() 重写

### 新签名

```typescript
// 之前
export async function login(browser: BrowserWorker, username: string, password: string): Promise<TokenResult>

// 之后
export async function login(username: string, password: string): Promise<TokenResult>
```

### 5 步 HTTP 链路

1. **GET `sso.cqu.edu.cn/login?service=https://my.cqu.edu.cn/authserver/authentication/cas`**
   - 正则提取 `execution`（id="login-page-flowkey"）、`croypto`（id="login-croypto"）、`captchaId`
   - 如果 captchaId 存在且 captchaCount API 返回 0 → 抛 `AuthError("CAPTCHA_REQUIRED", ...)`

2. **AES-ECB 加密 + POST `sso.cqu.edu.cn/login`**
   - `node:crypto` createCipheriv aes-128-ecb，PKCS7 padding（Node 默认）
   - 加密 password 和 `"{}"` (captcha_payload)
   - `redirect: 'manual'`，从 Location header 提取 `ticket=ST-xxx`
   - 401 → 解析 HTML `#login-error-msg` → 抛 `AuthError("INVALID_CREDENTIALS", ...)`

3. **GET `my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-xxx`**
   - 携带 CASTGC cookie
   - `redirect: 'manual'`，从 Set-Cookie 提取 SESSION cookie

4. **GET `my.cqu.edu.cn/authserver/oauth/authorize?client_id=personal-prod&response_type=code&scope=all&state=&redirect_uri=...`**
   - 携带 SESSION cookie
   - `redirect: 'manual'`，从 Location header 提取 `code`

5. **POST `my.cqu.edu.cn/authserver/oauth/token`**
   - grant_type=authorization_code，携带 code + client credentials
   - Authorization: Basic cGVyc29uYWwtcHJvZDphcHAtYS0xMjM0
   - 返回 access_token + refresh_token

### 错误处理

保持现有 `AuthError` 约定：
- `INVALID_CREDENTIALS` — 用户名或密码错误
- `CAPTCHA_REQUIRED` — 验证码触发（新增）
- `UPSTREAM_TIMEOUT` — 请求超时
- `UPSTREAM_UNREACHABLE` — 网络错误或上游异常

### 技术细节

- AES-ECB：`node:crypto`（wrangler.jsonc 已启用 `nodejs_compat`），零额外依赖
- HTML 解析：正则提取 3 个已知 ID 的元素值
- Cookie 管理：`redirect: 'manual'` + 手动传递 Set-Cookie → Cookie header
- `refreshToken()` 不变，已经是纯 HTTP

## 移除 Browser Rendering

### 代码变更

- `src/types.ts` — 删除 `BrowserWorker` import 和 `MYBROWSER` 属性
- `wrangler.jsonc` — 删除 `"browser"` 配置块
- `package.json` — 移除 `@cloudflare/playwright` 依赖
- `src/routes/users.ts` (2 处) — `login(c.env.MYBROWSER, ...)` → `login(...)`
- `src/cron/token-refresh.ts` (1 处) — `login(env.MYBROWSER, ...)` → `login(...)`

### 测试变更

- 移除 `fakeBrowser` mock
- 改为 mock `fetch` 模拟 5 步 HTTP 链路
- 测试用例：
  - 成功路径（完整 5 步 mock）
  - 密码错误（第 2 步 401）
  - 验证码触发（第 1 步 HTML 含 captchaId + count=0）
  - 网络超时（fetch 抛异常）
  - AES-ECB 加密（单独测试，已知输入/输出）
