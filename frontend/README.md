# CQU Schedule 前端

重庆大学课表订阅服务的前端（React 19 + Vite），基于 CQU Moe Design 设计系统（@cqu-moe/theme 与 @cqu-moe/ui，本地 tarball 分发于 .design/）。

## 常用命令

```sh
pnpm install        # Node 22.12+ / pnpm 11
pnpm run dev        # http://127.0.0.1:5173，/api 代理到本地 wrangler dev (8787)
pnpm run build      # tsc --noEmit && vite build
pnpm run test       # vitest run
pnpm run check:design  # 设计系统规则检查
pnpm run check:web     # Modern Web Guidance 辅助扫描（需联网获取 CLI）
```

`check:web` 固定扫描器版本，通过 `pnpm dlx` 临时运行，不增加应用依赖。
它仅覆盖指南库约 20% 的可静态识别规则；命中需要人工判断，零命中不代表可访问性或性能通过。
具体页面改动先按 `modern-web-guidance` 技能检索并读取对应指南，再使用现有检查验证。
本次检查结果见 [2026-11-16 审查记录](../docs/frontend/2026-11-16-modern-web-guidance.md)。
后续三项修复、验证与包体积分析见 [修复记录](../docs/frontend/2026-11-16-modern-web-fixes.md)。
已实施的分包和 CSS 优化、前后体积及验证边界见 [优化记录](../docs/frontend/2026-11-16-bundle-optimization.md)。

弹窗布局回归：在仓库根目录安装 `pnpm install --frozen-lockfile`，运行 `node node_modules/playwright-core/cli.js install chromium`
（Linux 增加 `--with-deps`），然后运行 `pnpm run test:frontend:layout`；快速复现用
`pnpm run test:frontend:layout --quick`。使用真实页面和合成 API 响应（包括模拟同步），不写入真实后端。逐帧检查扫码弹窗、
课表菜单及菜单转共享链接弹窗期间的水平位置和宽度，并检查关闭后的焦点与滚动锁恢复。
同时检查查看/复制按钮等宽，以及同步进入冷却提示期间这两个按钮的位置和宽度保持稳定。
共享链接表单检查 Enter 只提交一次和焦点返回；学院选择器检查 Tab / Enter / Space 展开与选择、焦点返回及焦点框不被滚动容器裁切。
覆盖 320/390/768/1440、双主题、减少动态效果及显示/隐藏滚动条；截图保存在 `.e2e/overlay-layout/`。
这项检查不验证后端业务或真实学校服务。

修改分包或升级共享 UI 包后，先在 `frontend/` 运行 `pnpm build`，再在根目录运行
`pnpm run test:frontend:layout --production`，验证实际生成的 JS/CSS；截图保存在 `.e2e/overlay-layout-production/`。

提交 .design/*.tgz、pnpm-workspace.yaml 和 pnpm-lock.yaml，其他机器才能离线安装。包未发布到公共 registry，不要改成 registry 依赖。

消费规则见 AGENTS.md；设计系统文档与示例在 node_modules/@cqu-moe/ui/dist/（START-HERE.md、docs/、examples/）。组件只从 @cqu-moe/ui 公开入口导入，图标用 lucide-react，业务样式用共享 token（var(--space-N)、var(--text-N)、语义色），不要硬编码设计值。

