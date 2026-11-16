# Modern Web Guidance 修复与包体积分析

日期：2026-11-16。起点：`675644e` 及[修复前审查](2026-11-16-modern-web-guidance.md)。本次修复三个已复现问题，并分析入口加载成本；性能候选没有改入生产代码。没有新增依赖、持久化状态或后端接口。

本记录保留三项修复完成时的结果；后续已实施的体积优化见[优化记录](2026-11-16-bundle-optimization.md)。

## 三项修复

| 问题 | 最小实现 | 验收证据 |
| --- | --- | --- |
| 教学周受设备时区影响 | `getSemesterWeek` 统一使用 UTC 星期与日期读写，保持 FullCalendar 的 UTC-coercion 约定 | UTC、上海、洛杉矶各运行相同的 10 个用例，共 30 项通过；覆盖学期前一天、首周周日、非周一开学和夏令时切换 |
| 学院选择器声明树语义，却只有按钮键盘行为 | 保留共享 Dialog/Button，改为可展开的嵌套列表；选择状态用 `aria-pressed`，展开状态仍为 `aria-expanded` | Tab、Enter、Space 展开与选择，焦点返回；加载、禁用、搜索测试保留；浏览器确认不再声明 `tree` |
| 共享链接按 Enter 不提交 | 原生 `<form onSubmit>`，外部共享 ActionButton 通过 `form`/`type="submit"` 关联，增加提交中防重；格式组使用 fieldset/legend | 点击/Enter 创建、Enter 编辑、提交中重复 Enter、失败保留草稿及重试、嵌套弹窗焦点返回 |

日期修复遵循 [FullCalendar v6 UTC-coercion](https://legacy.fullcalendar.io/v6/timeZone#UTC-coercion)，没有替换现有 UTC 日期格式化或引入 Temporal polyfill。

列表显式保留 `role="list"`：指南指出 Safari 会在 `list-style: none` 等样式下移除原生列表语义。人工截图还发现滚动区域裁切焦点框，先加入失败的浏览器断言，再用外层列表 `p-2` 留出空间；没有覆盖共享组件内部样式。

表单没有自定义 Enter 的 keydown 处理：`ime-safe-enter-submit` 明确说明，原生单行输入框的隐式提交由浏览器处理 IME 确认键。保留明确的提交按钮、格式校验和 API 错误反馈。`method="post"` 对应修改操作，避免原生回退时将标签串入 GET URL；实际业务请求仍由现有 API 客户端发送。原生 IME 行为没有用合成 composition 事件冒充实机验收。

## 验证

| 检查 | 结果 |
| --- | --- |
| Matt TDD | 修复前教学周/原生提交用例失败；修复后通过。焦点裁切断言先失败，再修复通过 |
| 前端全量 Vitest | 26 文件、298 项通过（`frontend/` 下运行 `node node_modules/vitest/vitest.mjs run`） |
| `pnpm build` | 类型检查和生产构建通过；入口仍有 500 kB 提示，详见下文 |
| `pnpm check:design` | 通过；`@cqu-moe/theme` / `@cqu-moe/ui` 1.3.0，lucide-react 1.48.0 |
| `npm run test:frontend:layout` | 11 组 Chromium 场景通过；既有浮层/同步过程最大水平位移均为 0 px，新表单与选择器键盘流程通过 |
| 人工截图 | 检查 390/768/1440 双主题及 320 内容重排；焦点框完整可见，字段与格式按钮换行正常 |
| 差异检查 | `git diff --check` 通过 |

浏览器矩阵：320/390/768/1440 × 明暗主题（8 组），1472 减少动态效果（1 组），390/1440 隐藏滚动条（2 组）。使用真实前端与合成 API 数据，不调用真实学校账号。截图在仓库根目录 `.e2e/overlay-layout/`，单测与浏览器日志在 `frontend/.e2e/modern-web-guidance/`，均是被忽略的本地验收产物。

本轮是具体问题修复，按技能使用相关指南和行为验收，没有重复运行面向全库现代化的 `legacy-scan`。此前的零命中只说明有限的静态规则没有发现问题。Vitest 中 PostHog 依赖的源码映射警告仍存在，不影响测试结果。

## Standards

Matt 规范轴独立审查：0 项已验证问题。UTC 修复、原生表单与列表语义、共享组件复用、焦点留白及回归测试符合已读的项目规范；测试与截图由主执行者验证。

## Spec

Matt 需求轴独立审查：复核后 0 项已验证问题。三项修复及入口分析均已完成。学院触发按钮的可访问名称来自 Add 页的关联 Label，浏览器已验证；表单 POST 对应指南的修改操作要求。

两轴分别为 Standards 0、Spec 0，无未处理的阻塞发现；两位审查代理实际使用 `zhipu/glm-5.3` / `max`。

## 主入口体积

最终常规 `pnpm build`（未设置生产遥测令牌）的输出，单位 kB，gzip 使用构建器的报告口径：

| 产物 | 构建后 | gzip |
| --- | ---: | ---: |
| 主入口 JS | 608.09 | 191.01 |
| 主入口 CSS | 101.16 | 18.04 |
| Calendar JS（异步） | 232.20 | 69.34 |
| Dashboard JS（异步） | 79.01 | 24.78 |
| Add JS（异步） | 25.00 | 8.36 |
| Docs JS（异步） | 7.82 | 2.90 |

此次修复没有优化入口依赖，入口大小基本不变。Calendar、Dashboard、Add、Docs 已经按路由拆分；不能把所有异步产物相加称为首屏下载量，也不能把调整 chunk 警告阈值称为性能优化。

额外使用现有 visualizer 和 Vite 构建 API 生成模块图，输出到独立的 `.e2e/bundle-audit/`，未覆盖常规 dist。下列为分析器的 **renderedLength 归因**，是压缩前模块数据，不是最终下载量，也不能相加估计 gzip 节省：

| 入口中的模块来源 | rendered 字节 | 判断 |
| --- | ---: | --- |
| React DOM | 535,942 | 页面运行必需，不为消除警告更换框架 |
| React Router | 210,531 | 当前路由与布局依赖 |
| Axios | 111,264 | 共享 API 客户端依赖；替换需保留错误、认证与超时契约，暂不优先 |
| 应用代码 | 62,463 | 入口、布局、会话与加载状态等 |
| Tailwind Merge | 56,801 | 共享 Button 等组件的 class 合并依赖 |
| Sonner | 53,442 | 入口单一 Toaster 依赖 |
| Radix Select | 43,176 | 仅在异步页面使用，但实际留在入口中，值得验证拆分 |
| `@cqu-moe/ui` 自身 | 34,922 | 公共入口为一个合并后的 JS 模块 |

### 优先候选：共享 UI 包的模块边界

`@cqu-moe/ui` 1.3.0 只有根入口、styles 和 charts 导出。静态壳层与异步页面共同导入同一个 `dist/index.js`；分析图显示仅在 Add/Dashboard 使用的 Select、Switch、Tabs 仍进入入口，三者分别为 43,176 / 7,326 / 5,528 rendered 字节。

可在设计系统源码仓库验证保留组件模块或公开子路径导出，再由应用使用正式入口。不要在 schedule 中深层导入 dist 内部文件或自行复制基础组件。它们的共享辅助模块和最终分块可能重叠，因此这里没有声称可以省下三者字节之和。

Sonner、Tailwind Merge、菜单和浮层不能一起算成可移除成本：主入口有 Toaster，Layout 有账户/主题菜单，Home 有弹窗。验收应比较同一环境下最终入口的文件字节、gzip、首屏请求与 CPU，再跑共享 UI 的组件验收及本项目布局/键盘矩阵。

### 次要候选：骨架屏静态带入页面 CSS

`RouteSkeleton → LoadingSkeletons.tsx` 静态导入 `dashboard.css`、`add.css`、`calendar.css` 以及 loading 样式，相关源 CSS 合计约 22.5 kB。可以只把骨架屏确实需要的布局规则留在静态路径，其余随页面加载。

这影响 CSS，不是 608 kB 的入口 JS。合并压缩会共享字典，不能用各文件单独 gzip 相加预测收益；也不能以首屏闪烁或骨架屏尺寸跳变换取字节减少。应优先完成 UI 模块候选，再判断这项收益是否值得维护成本。

### 另行计量：遥测动态块的启动时机

使用虚构令牌仅作构建对比，没有连接 PostHog 服务。带令牌时，`main.tsx` 立即调用 `initPostHog()`，其中 Promise.all 同时导入 core、recorder 和 exception-autocapture；动态导入并不意味着等用户交互后才请求。

同一独立分析流程中，无令牌入口为 608,098 字节 / 189,271 字节 Node-gzip，虚构令牌入口为 613,837 / 191,454，差值为 5,739 / 2,183。这只是初始化与调用代码的入口差值，下面的 SDK 是额外动态块。

这三个独立产物最终磁盘大小合计 550,788 字节，约 171 kB gzip（独立 Node 分析口径）。其中 recorder 为 202,850 字节、约 64.7 kB gzip。可评估按页面或空闲时机加载非关键录制器；必须保留异常采集、身份/事件重放和 URL/token 清洗约束。仅把初始化搬到首个 React effect 不能证明避开首屏，也不应以关闭全部遥测作为体积优化。

这属于启动加载成本，不是把 171 kB 从主入口中删除。实际生产是否配置令牌、CDN 编码、缓存和首屏请求顺序本次均未测量。

### 分析口径与复查入口

- 常规构建报告用于上面的发布产物表；独立分析器使用 Node `zlib.gzipSync`，不同运行时的压缩结果不要混作精确前后对比。
- 最终入口在常规 dist 和无令牌分析构建中均为 608,098 字节。构建插件 `generateBundle` 阶段的记录尚不是最后磁盘产物，最终文件大小须重新读取文件；模块归因则使用该阶段的图数据。
- 本地交互图：`.e2e/bundle-audit/no-token.treemap.html` 和 `no-token.network.html`；数据：`no-token-analysis.json`、`synthetic-token-analysis.json`。这些是本地分析产物，不随提交发布。
- 日常复查可用已有 `ANALYZE=true pnpm build`，产出 `frontend/dist/stats.html`。本轮没有增加持久化分析脚本或新构建依赖。

未做 LCP/INP 或线上分位数测量，未声明性能提升百分比。候选收益需要实际修改后的同口径构建和运行时对比才能确认。

## 验收边界

未测试 Safari/Firefox、真实手机、真实 OS 输入法或屏幕阅读器；Chromium 键盘测试与语义检查不能代替这些实机验证。没有执行后端全量测试、CI、提交、推送或部署。
