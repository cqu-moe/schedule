# CQU Schedule 前端

重庆大学课表订阅服务的前端（React 19 + Vite），基于 CQU Moe Design 设计系统（@cqu-moe/theme 与 @cqu-moe/ui，本地 tarball 分发于 .design/）。

## 常用命令

```sh
pnpm install        # Node 22.12+ / pnpm 11
pnpm run dev        # http://127.0.0.1:5173，/api 代理到本地 wrangler dev (8787)
pnpm run build      # tsc --noEmit && vite build
pnpm run test       # vitest run
pnpm run check:design  # 设计系统规则检查
```

弹窗布局回归：在仓库根目录安装 `npm ci`，运行 `node node_modules/playwright-core/cli.js install chromium`
（Linux 增加 `--with-deps`），然后运行 `npm run test:frontend:layout`；快速复现用
`npm run test:frontend:layout -- --quick`。使用真实页面和合成只读 API 数据，逐帧检查扫码弹窗、
课表菜单及菜单转共享链接弹窗期间的水平位置和宽度，并检查关闭后的焦点与滚动锁恢复。
覆盖 320/390/768/1440、双主题、减少动态效果及显示/隐藏滚动条；截图保存在 `.e2e/overlay-layout/`。
这项检查不验证后端业务或真实学校服务。

提交 .design/*.tgz、pnpm-workspace.yaml 和 pnpm-lock.yaml，其他机器才能离线安装。包未发布到公共 registry，不要改成 registry 依赖。

消费规则见 AGENTS.md；设计系统文档与示例在 node_modules/@cqu-moe/ui/dist/（START-HERE.md、docs/、examples/）。组件只从 @cqu-moe/ui 公开入口导入，图标用 lucide-react，业务样式用共享 token（var(--space-N)、var(--text-N)、语义色），不要硬编码设计值。

