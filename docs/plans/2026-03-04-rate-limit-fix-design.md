# Rate Limit 缺失修复设计

**Issue**: #33 — fix: add rate limiting to unprotected authenticated endpoints
**日期**: 2026-03-04
**优先级**: P2

## 问题

`src/routes/subscriptions.ts` 中两个认证端点缺少 rate limiting：

- `GET /api/v1/subscriptions` — 列出当前用户的所有订阅
- `DELETE /api/v1/subscriptions/:sub_token` — 删除指定订阅

其他同级认证端点均已配置 rate limiter。

## 审计结果

对所有路由文件进行了完整审计，确认仅上述两个端点缺失 rate limit。

config 端点 (health, config, captcha/config) 为无认证轻量端点，不做 DB/crypto 操作，不需要加 rate limit。

## 修复方案

在两个端点的中间件链中添加 `rateLimit("AUTH_LIMITER")`：

```typescript
// GET /api/v1/subscriptions
app.get("/", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {

// DELETE /api/v1/subscriptions/:sub_token
app.delete("/:sub_token", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
```

选用 `AUTH_LIMITER` 与 `GET /users/me`、`DELETE /users/me`、`POST /:sub_token/refresh` 保持一致。

## 测试

验证 rate limit 中间件正确挂载，确保现有测试继续通过。
