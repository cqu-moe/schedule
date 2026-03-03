# Security Headers Design

Issue: #16 — 缺少安全响应头 (CSP, X-Frame-Options 等)

## 问题

应用未设置关键安全 HTTP 响应头，增加 clickjacking、MIME 嗅探等攻击风险。

## 方案

在 `src/index.ts` 的 fetch handler 顶层，对所有响应（Hono API + 静态资源）统一注入安全头。

```
请求进来
  → API? → Hono 处理 → Response
  → 静态? → ASSETS.fetch() → Response
→ 统一注入安全头
→ 返回
```

## 安全头清单

| 头部 | 值 | 作用 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 防 MIME 嗅探 |
| `X-Frame-Options` | `DENY` | 防 clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 控制 Referer 泄露 |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=()` | 禁用不需要的浏览器 API |
| `Content-Security-Policy` | 见下方 | 限制可加载的资源来源 |

**HSTS 不设置**：Cloudflare 边缘已设置 `Strict-Transport-Security`，Worker 层无需重复。

## CSP 策略

基于前端资源分析（Google Fonts、hCaptcha、Cloudflare Analytics）：

```
default-src 'self';
script-src 'self' https://static.cloudflareinsights.com https://*.hcaptcha.com https://hcaptcha.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
frame-src https://*.hcaptcha.com https://hcaptcha.com;
connect-src 'self' https://*.hcaptcha.com https://hcaptcha.com;
img-src 'self' data:
```

- `'unsafe-inline'` for style-src：Tailwind/Vue 运行时需要
- `frame-src`：hCaptcha 验证码 iframe
- `connect-src`：hCaptcha API 通信
- 部署模式：直接强制执行（非 report-only），用浏览器 DevTools 验证

## 实现位置

`src/index.ts` fetch handler — 在获取 response 后、返回前，clone response 并追加安全头。
