# CQU AllCourseSchedule 外部课表恢复调研

日期：2026-10-14（Asia/Shanghai）

状态：调研报告。本文只回答“能否恢复、应如何恢复、在什么架构上恢复”；不包含实现、CI、部署或生产验收结论。

## 1. 决策摘要

1. **`https://my.cqu.edu.cn/tt/AllCourseSchedule` 是可行恢复入口。** 它覆盖教师、教室、实验室、课程、行政班等现有外部订阅类型，但它不是可拼参数的深链，也不会在初始加载时返回全校课表快照；必须由真实页面选择查询范围和目标后，才自然触发搜索与课表请求。
2. **不能恢复旧 `CQUAPIClient` 的纯 HTTP 直连路径。** 外部 `table-detail` POST 受瑞数写专守：缺失一次性 `CAqWHAeT` 密文会 412，重放已捕获密文会 400。课程和行政班的当前实测都确认请求必须由页面自然触发。
3. **可以在 Workers 上恢复业务层，不能把跨瑞数取数放进 Worker runtime 的普通 `fetch()`。** 推荐拓扑是 Schedule Worker 通过 Service Binding 调用 Auth 的类型化 RPC；Auth 继续用现有浏览器容器注入用户会话、执行固定 UI 动作并捕获响应。
4. **推荐新增类型化 `cquExternalSearch` / `cquExternalHarvest`，不要扩展现有 `cquHarvest` 为通用 POST/UI 代理。** 请求合同只接受业务字段和固定动作枚举；返回值只包含严格 schema 校验后的业务数据，不回传 Cookie、Bearer、浏览器 state、一次性密文或原始诊断。
5. **第一期建议恢复搜索、创建时一次性采集和手动刷新，暂不恢复外部订阅自动 Cron 同步。** 外部课表变更频率低于个人课表，先避免把 Cron 放大成大规模浏览器交互；待容量和错误率稳定后再分层放开。
6. **行政班不需要第一期排除。** 已实测不选学院也能按班级名全局搜索，再用旧订阅的 `sourceId` 精确选择；课表响应可按 `assignTeachingObject[].adminClassId` 校验目标。剩余风险是默认学院权限、非本科层次和不同账号页面权限。
7. **学生查询继续排除。** 现有产品外部类型刻意不包含学生；即使教务 UI 可查，也不应借外部课表功能暴露私人学生课表。

## 2. 调研范围与证据强度

| 证据层 | 覆盖范围 | 结论强度 |
| --- | --- | --- |
| 当前仓库源码 | 外部类型、旧端点、解析器、禁用守卫、Auth RPC 合同 | 能证明产品模型仍保留，但不能证明教务上游当前可用 |
| Auth 现有实现 | 有机导航、响应捕获、GET-only 原语、授权与限流边界 | 能证明可复用的浏览器基础，但无 UI action 能力 |
| 已授权 Ego Browser 实测 | 课程全流程、行政班搜索与课表流程、当前前端 chunk | 单账号、当期学期的强证据；不能推广到所有角色/账号 |
| 历史 Worker/WAF 实验 | 纯 HTTP POST 412、密文重放 400、浏览器内请求 200 | 支持拒绝纯 Worker 重放，但不替代新外部端点逐类验收 |

本次只记录脱敏后的方法、状态码、业务参数、schema 和 ID 映射。未记录或写入 Cookie、Bearer、`CAqWHAeT`、浏览器 storage、原始个人课表或完整行政班样本。

基线：`a1600fd`（`Migrate workflows to Blacksmith (#131)`），另含本报告未跟踪文件。

## 3. 当前仓库状态

外部功能不是简单被一个 UI 开关隐藏：

- 旧搜索端点仍集中在 `src/services/cqu-api.ts:14`，教师、教室、实验室、课程、行政班、院系端点仍在。
- 五类旧外部课表端点仍在 `src/services/cqu-api.ts:30`：`instructor`、`room`、`laboratory`、`course`、`admin_class`。
- 共享解析器 `parseCourses()` 仍在 `src/services/cqu-api.ts:222`，核心输入是 `classTimetableVOList[].courseName/instructorName/roomName/weekDay/teachingWeek/period/exprProjectName`。
- `EXTERNAL_DISABLED` 的注释明确说明它只控制用户提示和软守卫，不是取数能力开关，见 `src/config/external-availability.ts:3`。
- 外部路由先检查 `caps.calendar.external`，再返回统一 503，见 `src/routes/v2/external.ts:21`。
- producer 与 consumer 均无条件硬跳过外部订阅，见 `src/cron/schedule-sync.ts:218` 与 `src/cron/schedule-sync.ts:613`。这是安全边界：外部订阅若误走个人 harvest，会把订阅主人自己的个人课表写入对外公开链接。
- 当前个人 harvest recipe 使用 `/workspace/curriculum`，通过页面自动 POST 捕获课表，再用 in-page GET 补齐考试与学期，见 `src/services/cqu-harvest.ts:17`。
- 现有 `cquHarvest` 合同只允许 GET，见 `src/services/auth-rpc.ts:51`。它的设计目标是批量取数原语，不是 UI 自动化。

Auth 当前原语的能力与限制：

- 能校验 recipe、host 和 method，导航已登录浏览器、捕获响应，并在页面上下文执行 GET。
- 没有“选择下拉框、输入关键词、勾选候选、等待指定外部 table-detail”的 UI action 抽象。
- 等待逻辑只特殊识别个人 `/my-table-detail`，不能直接复用于 `/course/table-detail`、`/adminClass/table-detail` 等。
- 现有 RPC 授权语义属于个人同步；外部路径应改查 `caps.calendar.external`，并要求 CQU 绑定 active，避免权限混用。

## 4. AllCourseSchedule 实测结果

### 4.1 页面行为

已授权浏览器打开 `/tt/AllCourseSchedule` 后，页面标题为“排课管理 - 重庆大学”。查询范围包含教师、楼宇、教室、实验室、课程、行政班、学生。初始只渲染空课表，不触发外部 `table-detail`；选择目标后才发起课表请求。

网络层实际 URL 会被瑞数 VM 重写为只携带一次性 `CAqWHAeT` 密文。下文记录的是公开前端源码中的原始业务路径和参数，不记录密文值。

### 4.2 端点事实表

| 用途 | 方法与业务路径 | 请求体 | 实测/源码结论 |
| --- | --- | --- | --- |
| 教师搜索 | `GET /api/timetable/instructor/filter` | - | 页面源码使用；本期未逐类实测 |
| 教室搜索 | `GET /api/resourceapi/room/roomName-filter` | - | 页面源码使用；本期未逐类实测 |
| 实验室搜索 | `GET /api/timetable/course/LaboratoryId-filter` | - | 页面源码使用；本期未逐类实测 |
| 课程搜索 | `GET /api/timetable/course/info-by-name-or-code` | - | 实测 200，`{ status, data }` |
| 教学班搜索 | `GET /api/timetable/course/search-class-by-courseId` | - | 实测 200，raw array，含 `id/classNbr` |
| 院系列表 | `GET /api/resourceapi/department/list` | - | 旧客户端保留；可作为搜索辅助 |
| 行政班搜索 | `POST /api/timetable/admin-class/dept-admin-classes` | 院系 ID 数组；全局搜索为 `[]` | 实测 200，返回行政班数组 |
| 课程实验课表 | `POST /api/timetable/class/timetable/expr-prj/table-detail` | 实验项目 ID 数组 | 实测 200，结构与课表一致 |
| 课程课表 | `POST /api/timetable/class/timetable/course/table-detail` | 教学班 ID 数组 | 实测 200 |
| 行政班课表 | `POST /api/timetable/class/timetable/adminClass/table-detail` | 行政班 ID 数组 | 实测 200 |
| 教师/教室/实验室课表 | 对应 `{type}/table-detail` | 目标 ID 数组 | 旧客户端与页面源码保留；仍需逐类实测 |

### 4.3 课程流程

1. 页面构造课程搜索：

   ```text
   GET /api/timetable/course/info-by-name-or-code
       ?nameOrCode={keyword}&pageSize=50&sessionId={sessionId}
   ```

2. 选择课程后构造教学班搜索：

   ```text
   GET /api/timetable/course/search-class-by-courseId
       ?courseId={courseId}&sessionId={sessionId}
   ```

3. 页面先请求实验项目：

   ```text
   POST /api/timetable/class/timetable/expr-prj/table-detail?sessionId={sessionId}
   body: ["experimentId", ...]
   ```

   无实验项目时 body 为 `[]`，响应仍为 `{ classTimetableVOList, maxSection }`。

4. 页面再请求课程课表：

   ```text
   POST /api/timetable/class/timetable/course/table-detail?sessionId={sessionId}
   Content-Type: application/json
   body: ["teachingClassId", ...]
   ```

5. 课表条目除现有解析器字段外，还含 `classId`、`courseCode`、`classNbr`、`teachingWeekFormat`、`weekDayFormat`、`periodFormat`。关键兼容点：`classId` 与教学班搜索结果的 `id` 一致。因此可以一次抓取课程下多个教学班的响应，再由 Schedule 按 `sourceId === classId` 过滤，不必为每个教学班单独触发 POST。

课程实验项目的空数组与真实实验项目如何在现有 ICS 语义中合并，仍需用真实样本比对旧日历；不能只捕获普通课程 POST。

### 4.4 行政班流程

1. 保持学院为空，按班级名触发搜索。页面自然请求：

   ```text
   POST /api/timetable/admin-class/dept-admin-classes
   body: []
   ```

   实测 HTTP 200。行内含字符串 `id`、`className`、`departmentName`、`grade`、`personNumber` 等字段。宽关键词 `"03"` 达到页面固定 200 条上限；精确班级名会收敛到少量候选。因此旧订阅的 `sourceId + sourceName` 足以在全局候选中精确定位，不需要补存院系 ID；但搜索服务必须把 200 条视为可能截断，不能当作完整列表。

2. 选择当前有课的行政班后，页面自然请求：

   ```text
   POST /api/timetable/class/timetable/adminClass/table-detail?sessionId={sessionId}
   body: ["adminClassId"]
   ```

   实测 HTTP 200，响应为 `{ classTimetableVOList, maxSection }`。样本返回 42 行；每行都至少有一个 `assignTeachingObject[].adminClassId` 等于所选 `sourceId`，其中 34 行含现有解析器所需课程字段，其余为非普通课程/活动类行。适配器应按“任一 `assignTeachingObject[].adminClassId === sourceId`”过滤或校验，不能使用样本中未命中目标值的顶层 `adminClassId`。

3. 选择当前学期无课的高年级行政班时，接口同样返回 2xx 与空 `classTimetableVOList`。空数组是合法业务结果；缺 capture、非 2xx、schema 不合法才是采集失败。二者不能混淆，否则会要么误报故障，要么用空结果覆盖旧日历。

4. 页面源码会为行政班构造 `adminClassName-filter-with-deptIds` 的 GET URL，但 `getSearchList()` 对行政班忽略该 URL，实际始终走 `dept-admin-classes` POST。不要基于这段死代码把行政班并入 GET-only 搜索。

5. 源码在 `DefaultSelfCollege&KR_TT` 权限下会把学院自动设为本人学院。类型化 recipe 不能依赖页面初始状态，必须显式设置或清空学院、校区、层次、年级，再用 `sourceName` 收敛候选并按 `sourceId` 选择。

### 4.5 前端 chunk 证据

检查了页面当前加载的公开 chunk：

- `https://my.cqu.edu.cn/tt/static/js/chunk-70bbaea8.0b67f3e4.js`
  - SHA-256：`ec202c884427922909c910e34abffc0dc3a7b93660437acf32549344d49bdab4`
  - Last-Modified：`Tue, 13 Oct 2026 12:15:30 GMT`
- `https://my.cqu.edu.cn/tt/static/js/app.ef9f5d3f.js`
  - SHA-256：`365dd9adbeed11e38705de003d147e4f7dcb4bd3bea739706f90f078ae24df0a`

源码还证明：

- 组件不读取 `$route.query` / `route.query`，深链无法预选查询范围或目标。
- 课程、实验、行政班等参数构造都在该 chunk 内。
- 教师按 `instructorIdList` 过滤；教室/实验室按 `roomId`；行政班按 `assignTeachingObject[].adminClassId`。
- 教务响应的 CSP 不允许 Schedule 前端 iframe 嵌入并读取内容。

## 5. 目标 ID 与响应过滤映射

| `sourceType` | 搜索/选择策略 | 响应目标校验 | 特殊处理 |
| --- | --- | --- | --- |
| `course` | 课程关键词 -> 课程 -> 教学班列表，按教学班 `id` 选择 | `sourceId === classId` | 同时处理实验项目 POST 与普通课程 POST |
| `instructor` | 工号或姓名搜索，按教师 `id` 选择 | `sourceId` 命中 `instructorIdList` | 选择器与响应仍需实测 |
| `room` | 教室名搜索，按房间 `id` 选择 | `sourceId === roomId` | 选择器与响应仍需实测 |
| `laboratory` | 实验室名搜索，按实验室 `id` 选择 | `sourceId === roomId` | 页面实验项目/实验室控件需专项验收 |
| `admin_class` | 清空过滤 -> 班级名全局搜索 -> 按 `id` 选择 | 任一 `assignTeachingObject[].adminClassId === sourceId` | 200 条搜索上限；空课表合法 |

课程和行政班已有当前实测证据；教师、教室、实验室的端点与映射来自旧客户端和页面源码，实施前必须补同样的网络/动作验收。

## 6. Workers 与 Auth 架构

### 6.1 为什么不能纯 Worker 直连

标准 Worker runtime 不能执行教务页面 DOM 操作，也不能凭旧 Bearer 或捕获密文绕过瑞数：

- 缺失一次性 `CAqWHAeT` 的课表 POST 是 412。
- 重放已捕获密文是 400。
- 浏览器内由真实页面自然触发的请求是 200。
- 行政班搜索与行政班/课程 `table-detail` 都是 POST，不能放进现有 GET-only `fetch[]`。

因此，“部署在 Workers”不等于“用 Worker `fetch()` 直接取教务数据”。

### 6.2 推荐拓扑

```text
Schedule Worker
  frontend external search/create/refresh guards
  verify application session + caps.calendar.external
  KV search/harvest cache
  strict schema adapter + target filter
  runId guarded write
  public ICS/JSON
        |
        | Service Binding RPC (clientId/clientSecret + typed business fields)
        v
Auth WorkerEntrypoint
  verify service client + caps.calendar.external
  require active CQU binding
  rate limit / audit / deadline / reauth classification
        |
        | versioned, typed action recipe
        v
Auth browser container
  hydrate the user's kept-alive CQU session
  navigate /tt/AllCourseSchedule
  perform fixed UI actions only
  capture expected business responses
  return sanitized business payload only
```

责任边界：

- **Auth 负责**：身份与 CQU 绑定、外部 cap、浏览器会话、固定 UI 动作、host/action 白名单、限流、审计、超时、会话过期分类、响应捕获。
- **Schedule 负责**：业务路由、搜索缓存、schema 校验、目标过滤、课表解析、ICS/JSON 生成、runId guarded write、订阅生命周期。
- **不跨层传输**：Cookie、Bearer、localStorage/sessionStorage、浏览器 context、一次性 WAF 密文、原始网络诊断、无关页面数据。

Cloudflare Browser Rendering 理论上是另一条远程浏览器路线，但需要重新解决会话注入、权限、审计、并发、成本和超时，而且不是现有 Auth harvest 架构。第一期不应为了取消容器而引入这条新变量。

## 7. 类型化 RPC 设计

### 7.1 搜索

```ts
type ExternalSearchType =
  | "instructor"
  | "room"
  | "laboratory"
  | "course"
  | "admin_class"
  | "department";

interface CquExternalSearchArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  sourceType: ExternalSearchType;
  keyword: string;
  sessionId?: string;
  deadlineAt?: number;
}
```

返回值应是脱敏搜索结果，而不是原始页面 state：

```ts
interface ExternalSearchResult {
  items: Array<{
    id: string;
    name: string;
    extra?: string;
  }>;
  truncated?: boolean;
}
```

要求：

- 教师、教室、实验室、课程、院系可复用导航过墙后的 in-page GET。
- 行政班必须走类型化 UI capture，不能扩展成通用 POST。
- 结果按 `sourceType + sessionId + normalized keyword` 缓存，建议先 10–30 分钟，避免 debounce 每次启动浏览器。
- 行政班搜索达到 200 条时设置 `truncated: true`。
- 空结果、无权限、会话过期、WAF/challenge、浏览器 busy、超时必须是不同错误码。

### 7.2 课表采集

```ts
type ExternalHarvestSourceType =
  | "instructor"
  | "room"
  | "laboratory"
  | "course"
  | "admin_class";

interface CquExternalHarvestArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
  sourceType: ExternalHarvestSourceType;
  sourceId: string;
  sourceName: string;
  sessionId: string;
  deadlineAt?: number;
}
```

Auth 将其翻译为版本化 recipe：

1. 导航 `/tt/AllCourseSchedule` 并等待应用可用。
2. 显式选择查询范围。
3. 显式清空或设置学院、校区、层次、年级，不信任页面默认值。
4. 用 `sourceId`/`sourceName` 触发搜索。
5. 等待候选列表，按精确 ID 和名称选择唯一目标。
6. 等待该类型专属 `table-detail` 响应；课程还需等待实验项目响应。
7. 在 Auth 侧完成基础 schema 校验和脱敏，只返回业务 payload。

错误分类至少应包含：`CQU_SESSION_EXPIRED`、`PAGE_PERMISSION_DENIED`、`TARGET_NOT_FOUND`、`AMBIGUOUS_TARGET`、`CAPTURE_MISSING`、`UPSTREAM_NON_2XX`、`SCHEMA_INVALID`、`BROWSER_BUSY`、`DEADLINE_EXCEEDED`、`WAF_CHALLENGE`。

## 8. Schedule 侧数据规则

1. **严格 schema。** `classTimetableVOList` 必须是数组，`maxSection` 必须是数字；课程/行政班目标过滤字段必须存在且命中。不要把未知字段透传进数据库。
2. **目标过滤。** 课程按 `classId`；行政班按任一 `assignTeachingObject[].adminClassId`；教师/教室/实验室按对应映射。生产输出必须只包含目标 `sourceId` 的行。
3. **空结果与失败分离。** 2xx + 合法空数组可生成空课表；非 2xx、缺 capture、schema 不合法必须保留旧数据并进入错误状态。
4. **课程实验合并。** 需要显式定义普通课程与实验项目的去重/合并规则，并用真实样本比对旧 ICS。
5. **缓存。** 搜索缓存可短期；成功课表缓存建议按产品确定的 TTL（例如小时级）存储。失败永不写入成功缓存。
6. **guarded write。** 继续复用 runId guarded write，防止并发刷新或队列重试用旧结果覆盖新结果。
7. **权限撤销。** `external` cap 撤销后停止新搜索/刷新；已有公开链接处理需与现有 share/caps 语义保持一致。

## 9. 实施切分

### Phase 1：Auth 类型化 provider

在独立 Auth worktree 中新增 RPC，不改动现有个人 `cquHarvest` 语义。

验收：

- `caps.calendar.external` fail closed；CQU 绑定非 active 拒绝。
- 只允许固定 action recipe 和 `my.cqu.edu.cn` 业务路径。
- 不出现任意 URL、selector、method 或 POST body 透传。
- 服务密钥、限流、审计、会话过期熔断、浏览器 deadline 全覆盖。
- 用脱敏 fixture 覆盖课程、行政班、空课表、目标不存在、同名候选、WAF/非 2xx、capture 缺失。

### Phase 2：Schedule 纯适配器

先实现 schema、目标过滤、错误映射、缓存和 ICS 生成，不打开用户入口。

验收：

- 纯 unit tests 覆盖五类 sourceType。
- 课程多教学班过滤、实验项目、行政班 nested ID 过滤、合法空课表、非法 schema、非 2xx 均有测试。
- 失败不覆盖旧 `coursesJson/icsContent`。
- Service Binding mock 覆盖旧/新 Auth 兼容和 RPC 错误。

### Phase 3：补齐教师、教室、实验室验收

课程与行政班已有强证据；教师、教室、实验室必须逐类在同一登录浏览器中验证搜索、选择、请求体、响应 schema 和 ID 映射。记录脱敏 fixture，不落个人数据或密文。

### Phase 4：搜索 + 创建/手动刷新灰度

先在内部/灰度环境打开搜索、创建时一次性采集和手动刷新。

验收：

- 五类来源各完成一次真实创建与刷新。
- 固定学期与当前学期都可刷新。
- 已冻结旧订阅能重选或明确迁移，不能伪装成功。
- 外部 provider 与个人 provider 完全分离。
- producer/consumer hard-skip 保留。

### Phase 5：分层放开用户入口

在外部 provider 稳定后再依次调整：

1. 外部搜索路由 503。
2. 前端隐藏入口与创建守卫。
3. 手动刷新守卫。
4. 最后评估 producer/consumer 自动同步。

每一步独立部署与回滚，不允许一次性删除全部守护。

## 10. 验收矩阵

| 层级 | 必测项 |
| --- | --- |
| 本地纯测试 | schema、目标过滤、空结果/失败、缓存、ICS、runId 写入、权限 fail closed |
| Auth 集成 | 固定 UI recipe、响应捕获、错误码、限流、审计、deadline、reauth、浏览器 busy |
| Schedule Worker 集成 | Service Binding mock、旧/新 Auth 兼容、路由 caps、缓存命中/过期、并发刷新 |
| 已登录业务验收 | 五类来源、当前学期/固定学期、搜索无结果、同名目标、空课表、课程实验、多教学班 |
| 权限与安全 | 无 external cap、CQU 解绑、学生类型拒绝、任意 URL/selector 拒绝、敏感字段不出 Auth |
| 生产验收 | 部署版本、真实端点、公开 ICS/JSON 只含目标行、错误不覆盖旧数据、日志无凭据 |

## 11. 风险与开放问题

- 单账号可见不代表所有学生、研究生、教师或管理员账号都有 `ViewCourseTeacherSchedulePage&KR_TT` 权限。
- `DefaultSelfCollege&KR_TT` 可能自动填本人学院，recipe 必须显式清空或设置过滤。
- 行政班非本科层次、研究生班级、同名班级和多校区仍需专项验收。
- 课程实验项目与普通课程的合并语义未完成真实样本比对。
- 旧外部订阅 `sourceId` 可能已失效；目标不可识别时应进入迁移/重选状态，不能返回假成功。
- 外部课表上游更新频率、可接受缓存 TTL、浏览器并发容量和自动同步间隔需要产品决策。
- 前端 chunk 升级会破坏 UI action；需要版本化 recipe、chunk 指纹监控和明确失败码。

## 12. 不建议的方案

1. **纯 Worker/HTTP 重放 Bearer 或 WAF 密文**：412/400 边界明确，密文一次性，维护成本高。
2. **通用 URL/POST 代理**：会把受限业务动作扩大成任意教务请求代理，违背 host/method/action 白名单。
3. **AllCourseSchedule 深链**：页面不读 query，无法预选目标。
4. **Schedule 前端 iframe**：CSP 与跨域边界都不允许读取内容。
5. **Excel 导出解析**：增加下载和表格解析脆弱性，无法复用现有 JSON schema 与测试。
6. **恢复学生外部查询**：引入私人课表越权暴露风险。
7. **先删除 producer/consumer hard-skip**：在外部 provider 未落地前会导致错误入队或个人课表污染公开链接。

## 13. 参考

- 旧外部搜索与课表端点：`src/services/cqu-api.ts:14`、`src/services/cqu-api.ts:30`
- 共享解析器：`src/services/cqu-api.ts:222`
- 外部禁用语义：`src/config/external-availability.ts:3`
- 外部路由守卫：`src/routes/v2/external.ts:21`
- 外部 producer/consumer hard-skip：`src/cron/schedule-sync.ts:218`、`src/cron/schedule-sync.ts:613`
- 个人 organic harvest：`src/services/cqu-harvest.ts:17`
- 当前 Auth RPC 合同与 GET-only 边界：`src/services/auth-rpc.ts:51`
- 历史 WAF/Worker 证据：`docs/plans/2026-06-23-cqu-rushu-data-proxy-design.md:9`
