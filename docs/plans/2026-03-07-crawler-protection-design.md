# Crawler Protection Design

## 目标

保护用户日历数据不被搜索引擎索引，同时允许 AI 爬虫和普通爬虫访问公开页面。

## 现有措施（已足够）

- `robots.txt`: 已 `Disallow: /api/`，覆盖所有用户数据端点
- `sitemap.xml`: 只收录公开页面（`/`、`/api-docs`、`/changelog`）
- SEO 中间件: 未列在 `ROUTE_META` 中的页面默认 `noindex: true`
- ICS 端点有 rate limit

以上措施已充分保护用户数据。公开页面（首页、API 文档、更新日志）欢迎所有爬虫（包括 AI 爬虫）访问和索引。

**不需要修改 robots.txt**：无需添加 AI 爬虫 User-agent 规则，AI 爬虫可以自由访问公开页面。

## 新增：X-Robots-Tag（纵深防御）

在 `src/index.ts` 中，对所有 `/api/*` 响应添加 `X-Robots-Tag: noindex, nofollow` header。

作为纵深防御措施：即使爬虫不遵守 robots.txt 的 `Disallow: /api/`，响应头仍能告知搜索引擎不要索引用户数据。

## 不做的事

- **不修改 robots.txt**: 现有规则已足够，AI 爬虫应可访问公开页面
- **不开启 Bot Fight Mode**: ICS 端点需要被日历客户端（自动化 HTTP 请求）访问，Bot Fight Mode 会误拦截
- **不加 Cache-Control: private, no-store**: ICS 内容预生成存储在 D1，CDN 缓存可减轻 Worker 压力，无额外泄露风险
- **不做 User-Agent 硬拦截**: 不对任何爬虫返回 403

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/index.ts` | API 响应添加 `X-Robots-Tag` header |
