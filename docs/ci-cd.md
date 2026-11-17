# 开发与部署

根目录、`frontend/` 和 `video/` 各自使用 `package.json` 固定的 pnpm 及独立锁文件；不在仓库根合并 workspace。分别执行 `pnpm install --frozen-lockfile`、`pnpm --dir frontend install --frozen-lockfile` 和需要视频工具时的 `pnpm --dir video install --frozen-lockfile`。

## 检查

- 根目录：`pnpm typecheck`、`pnpm typecheck:e2e`、`pnpm test`。
- 前端：`pnpm --dir frontend build`、`pnpm --dir frontend check:design`、`pnpm --dir frontend test`，随后 `pnpm test:frontend:layout --production`。
- 视频：遵循 [视频 README](../video/README.md)；`postrender` 继续生成封面并执行完整视频解码检查。
- 应用 E2E：遵循 [E2E README](../e2e/README.md)，保留当前 Chromium 门禁及发布浏览器矩阵。

GitHub Actions 以各依赖目录的 pnpm 锁文件确定 store 缓存。E2E 的 `e2e/auth-dependency.json` 固定在迁移前的 Auth，仍用 npm 安装该历史提交根依赖；这条兼容路径和 npm 缓存须在明确升级 Auth pin 并完成集成验收后再移除。

## Cloudflare Workers Builds

Cloudflare 构建变量固定 `PNPM_VERSION=11.19.0`、`NODE_VERSION=22.22.3`，并设置 `SKIP_DEPENDENCY_INSTALL=1`，由以下命令明确选择冻结安装。按根锁文件分支，保留迁移前提交的 npm 重建能力：

- 根目录：`/`；Node 22.22.3；pnpm 与根 `packageManager` 一致。
- Build command：`if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi`。
- Deploy command：`if [ -f pnpm-lock.yaml ]; then pnpm run deploy; else npm run deploy; fi`。
- Non-production version command：`if [ -f pnpm-lock.yaml ]; then pnpm run build:frontend && pnpm exec wrangler versions upload; else npm run build:frontend && npx wrangler versions upload; fi`。

`build:frontend` 冻结安装并构建前端，保留 telemetry host 与 release 标识。`deploy` 继续在部署前运行远程 D1 迁移；版本上传不执行生产迁移，也不切换生产流量。保留现有 PostHog 构建变量、secrets、分支触发器及 Git Connector 发布方式。

2026-11-18 已保存并重新加载核对上述控制台设置；未触发构建或部署。控制台提示 GitHub 用户或组织信息获取失败，Connector 可用性仍需真实云端构建验证。
