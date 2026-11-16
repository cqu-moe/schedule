# 首屏包体积优化

日期：2026-11-16。承接[三项修复及分析](2026-11-16-modern-web-fixes.md)，本轮实际完成共享 UI 包模块拆分和骨架屏 CSS 拆分。保留公开组件 API、视觉与键盘行为、路由、鉴权及遥测策略。

## 结果与统计口径

比较对象是上一轮修复后的生产构建与本轮最终 frozen-lockfile 构建。下表读取最终磁盘文件，gzip 统一使用 Node 22.22.3 的 `zlib.gzipSync`；单位为十进制 kB。它与 Vite 日志的 gzip 实现不同，不能混用作前后差值。

| 首屏资源 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| 同步 JS 完整依赖图 | 608.10 | 572.45 | 35.65（5.9%） |
| 同步 JS gzip | 189.27 | 181.54 | 7.74（4.1%） |
| 首屏 CSS | 101.17 | 89.82 | 11.34（11.2%） |
| 首屏 CSS gzip | 18.03 | 16.32 | 1.71（9.5%） |
| JS + CSS gzip | 207.30 | 197.86 | 9.44（4.6%） |

入口文件本身是 378.21 kB，但同步依赖一个 194.24 kB 共享块，所以不能宣传为“608 → 378”。首屏 JS 请求从 1 个变为 2 个，HTML 为共享块生成 modulepreload。这里未测量真实网络上的 LCP、INP 或加载时间，不把字节下降解释成速度提升百分比。

分包存在代价：全部 JS 产物合计从 955.16 → 955.78 kB；各文件 gzip 相加从 295.53 → 299.41 kB，增加 3.89 kB。首次直达 Add 的 JS gzip 从 199.09 → 200.87 kB；其 CSS 减少抵消了大部分增量，但仍不是所有入口都更省流量。Dashboard、Calendar、Docs 的首次 JS 依赖图分别减少约 4.57、7.74、7.21 kB gzip。已加载资源可由后续路由复用，但本次没有模拟 CDN 缓存命中。

## 实现

### 共享包保留内部模块

在 design 的隔离工作树 `codex/schedule-ui-modules` 修改 `scripts/build-ui.mjs`：esbuild 以各 TS/TSX 文件为入口，启用 ESM splitting 和 `outbase: src`，构建前清理生成目录，防止旧 hash chunk 留在新包中。公开导入仍为 `@cqu-moe/ui` 和 `@cqu-moe/ui/charts`，消费项目没有深层导入、复制组件或直接依赖 Radix。[esbuild 官方构建说明](https://esbuild.github.io/api/#splitting)

新构建与原有 `sideEffects` 声明一起，使 Vite 能将 Select、Switch、Tabs 等仅供异步页面使用的依赖留在异步块。共享 React、路由、Toaster、菜单等必要部分仍计入首屏。

theme/UI 同步生成本地候选版本 **1.3.1**，更新模板和分发文档。schedule 接入实际 tarball，更新 manifest、override、锁文件、来源说明及 SHA256SUMS，移除被替代的 1.3.0 归档。第三方依赖版本保持原样；安装中新解析出的 d3、victory-vendor、tslib 升级已排除，并通过 frozen-lockfile 重装验证。

设计源码提交为 [`caa527c`](https://github.com/cqu-moe/design/commit/caa527c1b9df926e14968f6d68c50820461d2e04)，tarball 是候选版本，不是已发布版本。来源和校验值见 `frontend/.design/README.md`、`SHA256SUMS`。

### 首屏只加载必要的页面样式

`LoadingSkeletons.tsx` 不再静态导入 Dashboard/Add/Calendar 的完整 CSS。骨架屏与页面共同使用的几何规则和响应式规则移入 `loading.css`，只保留一份；菜单、共享链接、交互状态等页面专用样式随相应路由加载。没有更换类名或覆盖共享组件内部样式。

这里保留构建时 CSS 导入，没有引入运行时样式加载器、Service Worker 或新依赖。按 `performance` 指南的 “DON'T load invisible or unreachable CSS/JS” 控制静态路径，并通过真实构建与浏览器验证，而不是调整体积警告阈值。

## 验收

| 边界 | 结果 |
| --- | --- |
| 共享包消费回归 | Vite 消费者静态使用 Button、动态使用 Select：旧打包方式断言失败，新打包方式通过；同时确认 Select 仍存在于异步产物 |
| design `pnpm check` | 构建、类型检查、5 项 Vitest、28 项 Node 测试及设计规则均通过 |
| design `pnpm test:e2e` | 108 项 Chromium 桌面/手机测试通过 |
| design `pnpm verify:consumer` | 独立创建、安装、构建、双主题、图表、通知与交互通过；归档 SHA-256 与 schedule 内的两个 tarball 完全一致 |
| schedule 前端测试 | 26 文件、298 项通过 |
| schedule 构建/设计检查 | `pnpm build`、`pnpm check:design` 通过；最终 frozen-lockfile 构建保留已测产物的内容 hash 文件名和全部 JS 字节/gzip 合计 |
| schedule 生产布局/键盘 | `npm run test:frontend:layout -- --production` 的 11 组场景通过，水平位移 0 px，Enter 提交、学院选择、焦点恢复、无横向溢出、无浏览器错误 |
| 其余生产路由 | 首页、Docs 表格、Calendar 导航、旧 `/calendar/:token` 跳转均用合成 API 验证通过，无浏览器错误 |
| 骨架屏对照 | 320/390/768/1440 × 双主题 × Dashboard/Add/Calendar，共 24 对、48 次渲染；同时阻塞页面 JS 与 CSS，几何和计算样式完全一致，24 对截图逐像素相同 |
| 人工截图 | 查看 390/768/1440 双主题骨架与实际弹窗，以及 320 重排；没有新增视觉例外 |
| 归档校验 | `shasum -a 256 -c SHA256SUMS` 两包通过 |
| 差异检查 | 两个源码工作树 `git diff --check` 通过 |

独立消费者验收与设计浏览器测试共享候选包锁；最初并行启动的消费者因锁占用退出，浏览器完成后串行重跑通过，没有跳过检查或删除锁强行运行。

### Standards

独立规范轴审查无已验证的阻塞问题；公开导入、版本、锁文件、归档一致性及共享组件边界保留。

### Spec

独立需求轴审查无已验证的阻塞问题；首屏改善按完整同步依赖图计算，并明确记录全量与 Add 冷启动的 gzip 代价。两位审查代理使用 `zhipu/glm-5.3` / `max`。

## 本地证据与边界

- `.e2e/bundle-opt/metrics.json`：入口完整同步图及各路由首次 JS 依赖图，读取最终产物字节。
- `.e2e/bundle-opt/loading/`：24 对优化前后截图和几何记录；`check-loading.mjs` 为本轮临时验收脚本。
- `.e2e/overlay-layout-production/`：生产分包下的布局与交互截图；`e2e/overlay-layout.mjs` 的 `--production` 可重复运行。
- design `artifacts/bundle-opt/` 与 `artifacts/e2e/`：共享库检查、浏览器与独立消费者验收记录。

未修改 PostHog 初始化、录制器或 URL/token 清洗策略；未测生产令牌配置下的加载时间。Safari/Firefox、真机、真实输入法、屏幕阅读器与线上性能未验收。上表是本地验收记录；提交 PR 后的 CI 以对应 head 的检查结果为准。未执行 registry 发布或手动部署。
