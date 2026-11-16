# Modern Web Guidance 审查记录

日期：2026-11-16。代码基线：`675644e`。范围：前端配置、语义与键盘交互、日期处理、构建体积。这是修复前的审查快照，保留当时的复现与验收边界；三个问题的后续修复、验证及包体积分析见 [修复记录](2026-11-16-modern-web-fixes.md)。

## 已配置

- `frontend/package.json` 增加 `pnpm check:web`，临时执行固定版本 `modern-web-guidance@1.0.0`，不增加应用依赖或修改锁文件。
- `frontend/AGENTS.md` 增加按能力检索、读取指南、浏览器回退、共享组件边界及验证要求；根入口补齐前端与既有 Matt 文档导航。
- `frontend/README.md` 增加命令、覆盖边界和本记录入口。
- 复用既有 Matt issue tracker / domain 配置；本次不创建 issue、PR 或发布。

这是辅助审查命令，不是新的 CI 必需门禁。扫描只覆盖指南库约 20% 的静态规则，需要人工排除误报，不能替代构建、交互测试及设计检查。`pnpm dlx` 的临时运行方式见 [pnpm 官方文档](https://pnpm.io/cli/dlx)。

## 优先处理的三个问题

### 1. 教学周计算依赖用户设备时区（P2，已复现）

位置：`frontend/src/utils/calendarWeek.ts:3–10`；调用方为 `frontend/src/views/Calendar.tsx` 的当前教学周及周数显示。

学期开始日期以 `T00:00:00Z` 解析，随后却使用本地时区的 `getDay()`、`getDate()` 和 `setDate()` 寻找周一。西半球用户的同一 UTC 日期可能落在前一天，导致教学周提前或错误地显示为不在教学周内。

在 `frontend/` 直接运行已有测试，无需新增用例：

```sh
TZ=Asia/Shanghai node node_modules/vitest/vitest.mjs run src/utils/__tests__/calendarWeek.test.ts
TZ=America/Los_Angeles node node_modules/vitest/vitest.mjs run src/utils/__tests__/calendarWeek.test.ts
```

结果：上海 9/9 通过；洛杉矶 6/9 通过、3 项失败。例如学期从 `2025-09-01` 开始时，`2025-09-07` 应为第 1 周，实际为第 2 周；`2025-08-31` 应不在教学周内，实际为第 1 周。

最小修复方向：统一使用 UTC 的星期与日期读写方法，复用现有函数，不引入 Temporal polyfill。当前 FullCalendar 未安装命名时区插件，其 API 使用 UTC-coercion；事件详情中显式使用 UTC 的 `Intl.DateTimeFormat` 应保留。[FullCalendar v6 官方说明](https://legacy.fullcalendar.io/v6/timeZone#UTC-coercion)

验收：同一套教学周测试在上海、洛杉矶和 UTC 下通过，并覆盖学期前一天、第一周周日、非周一开学及夏令时跨度。

### 2. 学院选择器的树语义与键盘行为不一致（P2，已复现）

位置：`frontend/src/components/DepartmentTreeSelect.tsx:99–154,251`。

组件声明 `tree` / `treeitem`，但节点只有点击处理，没有树控件的方向键导航、Home/End 或单一 Tab 入口。带子节点的根分组还是普通按钮，子分组未由对应 `treeitem` 包含。屏幕阅读器用户得到的是树控件语义，实际操作却是逐个 Tab 的按钮列表。

使用真实组件、Testing Library 与 jsdom 的临时诊断：打开两个学院的选择器，将焦点置于第一个选项，按 ArrowDown；焦点仍在第一个选项，期望移到第二个的断言失败。现有测试覆盖点击、搜索和禁用，未覆盖方向键。

最小修复方向：优先保留共享 Dialog/Button，把它明确表达为可展开的列表与选择按钮；如果产品确实需要树控件，再完整实现树的焦点和键盘模型。不要只补一个 ArrowDown 或只删除部分 ARIA。依据为 `accessibility` 的 “Match ARIA implementations to actual behavior” 与 [WAI-ARIA Tree View 模式](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)。

验收：选择、展开、筛选后焦点、Escape 返回、禁用与加载状态均可键盘完成；最终语义和交互一致。屏幕阅读器仍需真实浏览器复验。

### 3. 共享链接编辑区缺少原生表单提交（P2，已复现）

位置：`frontend/src/components/ShareLinksDialog.tsx:503–558`。

标签和格式控件由 `div` 包裹，创建/保存只接 `onClick`；共享 `ActionButton` 默认是 `type="button"`。在标签输入框按 Enter 没有提交入口。

使用真实组件和模拟 API 的临时诊断：打开新建链接，输入标签后按 Enter，`createLink` 调用次数为 0。现有点击创建与关闭焦点测试通过，因此这不是创建 API 本身失败。

最小修复方向：用 `<form onSubmit>` 统一提交，创建/保存显式 `type="submit"`，取消和格式切换显式 `type="button"`。提交处理保留防重、格式校验和服务端错误反馈；格式组可用 `fieldset` / `legend` 关联名称。依据为 `forms` 的 “use the `<form>` element to wrap interactive controls for data collection” 与 [HTML 表单提交规范](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission)。

验收：点击和 Enter 都只提交一次；中文输入法选词不误提交；提交中防重、失败后可重试、关闭后焦点恢复均保留。

## 性能候选：先测量再拆分

本地 `pnpm build` 的主要产物如下，单位为构建器输出的 kB：

| 产物 | 压缩前 | gzip |
| --- | ---: | ---: |
| 主入口 JS | 608.09 | 191.02 |
| Calendar JS | 232.19 | 69.33 |
| Dashboard JS | 78.79 | 24.71 |
| 主入口 CSS | 101.09 | 18.02 |

主入口触发 500 kB chunk 警告，可优先用现有 `ANALYZE=true pnpm build` 分析组成，再在相同设备与网络条件下对比首屏和交互。项目已有按路由动态加载，不应仅靠提高警告阈值或机械拆 vendor 包来宣称提速。`performance` 指南支持按实际加载需求拆分。

这里是未设置生产遥测令牌的本地构建，不代表带完整生产环境变量的总下载量。此次未测 LCP、INP、CLS 或线上用户分位数，没有证据支持性能提升百分比。

## 保留与排除

- 保留共享设计系统的弹窗、菜单、主题与焦点管理；指南的原生示例不是在业务侧重写基础组件的理由。
- 保留构建时 CSS `@import`：构建产物已合并，不能按浏览器运行时串行请求判错。
- 保留路由动态导入、跳至正文、路由标题更新、加载区域 `inert` 及减少动态效果支持。
- 保留日历后台刷新合并、离线/隐藏页抑制、旧响应丢弃、失败保留数据以及 403/404 清除旧课表的行为。
- 不将订阅请求合并推断成 HTTP 缓存缺陷：`src/routes/v2/subscriptions.ts` 已返回 `Cache-Control: private, no-store`，尚无陈旧内容复现。
- 日历请求卸载后未主动取消属于次要资源优化候选；已有旧响应隔离与请求超时，本次不将其列为数据错误。
- 不为小页面添加 `content-visibility`，不引入 Service Worker 或新的日期依赖。

## 验证与边界

| 检查 | 结果 |
| --- | --- |
| Modern Web Guidance 1.0.0 `legacy-scan frontend/src --json` | 0 命中；33 类指南、35 条规则，跳过 26 个文档/测试文件 |
| 新命令 `pnpm check:web` | 成功，扫描结果一致 |
| `pnpm build` | 通过；主入口 chunk 大小警告如上 |
| `pnpm test`（默认环境，既有测试） | 26 文件、274 项通过；PostHog 包有源码映射警告 |
| `pnpm check:design` | 通过 |
| 教学周跨时区诊断 | 上海 9/9 通过；洛杉矶 3 项失败，确认待修问题 |
| 临时键盘诊断 | 2 项按预期失败，确认待修问题；jsdom，不是浏览器或读屏验收 |

临时键盘脚本与日志仅保留在本工作树被忽略的 `frontend/.e2e/modern-web-guidance/` 中。运行后脚本改名为 `keyboard-probe.repro.tsx`，不加入常规测试发现；若要重复运行，临时恢复 `.test.tsx` 后使用现有 Vitest。诊断失败与既有测试通过分别记录，不代表问题已修复。

设计系统：`@cqu-moe/theme` / `@cqu-moe/ui` 1.3.0，lucide-react 1.48.0。本次没有视觉或业务代码变更，没有新增设计例外、生产依赖或持久化状态。

SKIP：浏览器截图矩阵、Safari/Firefox、真实手机、屏幕阅读器、线上性能与真实学校账号操作；此次交付为配置和审查，不是 UI 修复验收。未提交、推送或部署。

## 指南来源

按指定技能执行搜索并完整读取：`forms`、`accessibility`、`performance`、`coordinate-global-events`；检索使用 `--skill-version 2026_11_09-5bcc021b`，扫描器固定 1.0.0。前三者用于表单、语义及性能审查，日期指南用于明确时区与兼容边界，FullCalendar 的具体日期约定以官方文档为准。本次没有将指南示例直接替换进应用代码。
