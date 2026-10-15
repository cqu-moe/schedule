# 教师完整目录替代路径研究

研究日期：2026-10-15（Asia/Shanghai）

> **最新决定（2026-10-15）：** 用户已否决逐教学班反查教师的实施方式，教师目录延期至 [Issue #152](https://github.com/cqu-moe/schedule/issues/152) 继续研究低请求量来源。生产未启动这轮逐班采集；教室、实验室、课程和行政班目录独立每周缓存。下文保留历史研究与决策过程，不再代表允许启用逐班方案。

## 结论

当前账号下，**教师完整目录仍未取得**。本轮补查了公开前端源码、现有登录态的只读接口和学校公开教师主页；未实施生产缓存、同步任务或部署。每周更新、失败沿用旧数据、缓存未命中自动回源的产品决定保持不变；继续遵守“教师全量解决后再实施”的条件。

有两项实质进展：

1. `POST /instructor-arrange/list` 能返回教师姓名与工号，突破普通搜索的 10 条结果限制，但当前实测只取得辛辛那提联合学院 82 人，没有教师 ID 和独立总数；不能认作全校教师名录。
2. `GET /class/classNbr-filter` 能批量返回 **8461 个唯一教学班 ID**，两个较大上限下集合一致。10 门课程在学期 `1061` 查到的 16 个教学班全部包含其中。这是此前逐门查询之外的有效目录候选，但不自动解决教师完整性。

## 第一方来源与证据定位

以下均为学校实际运行的公开脚本；`@位置` 是压缩源码中的近似文本位置，便于搜索复核，不代表行号或 UTF-8 字节偏移。脚本调用只能证明接口和参数存在；可用性结论来自下节当前账号的实测。

| 编号 | 第一方来源 | 关键位置与用途 |
| --- | --- | --- |
| S1 | [排课系统主脚本 app.e20a2e81.js](https://my.cqu.edu.cn/tt/static/js/app.e20a2e81.js) | `@2858515` 请求封装与 timetable/resourceapi 基址；`@3727573` 单教学班教师；`@2508950` 普通教师搜索；`@3730681` matching 搜索 |
| S2 | [教师安排 chunk-2c3de690.67670150.js](https://my.cqu.edu.cn/tt/static/js/chunk-2c3de690.67670150.js) | `@2172` 默认学院；`@5801` 时间筛选后的教师安排查询；学院 finder 使用 resourceapi |
| S3 | [教学班管理 chunk-4272fd7c.8122c752.js](https://my.cqu.edu.cn/tt/static/js/chunk-4272fd7c.8122c752.js) | `@166261` common-teachers；`@182050` 教学班分页及 totalElements |
| S4 | [专任教师列表 chunk-d33a57c2.c5a45285.js](https://my.cqu.edu.cn/tt/static/js/chunk-d33a57c2.c5a45285.js) | `@13939` 教师分页；`@7016` 同筛选条件导出按钮 |
| S5 | [师资管理 chunk-2a5e960c.a6a32b5d.js](https://my.cqu.edu.cn/tt/static/js/chunk-2a5e960c.a6a32b5d.js) | `@16899` instructor-resource/page |
| S6 | [教师工作量 chunk-2062a90a.4dcc463c.js](https://my.cqu.edu.cn/tt/static/js/chunk-2062a90a.4dcc463c.js) | `@7101` 工作量统计；之前为父组件实际传入 session、dateStart、dateEnd 等条件 |
| S7 | [空闲时间查询 chunk-50fed164.4da0c40c.js](https://my.cqu.edu.cn/tt/static/js/chunk-50fed164.4da0c40c.js) | `@17200` 附近的 changeSelect：教师仍走 instructor/filter，教学班走 class/classNbr-filter |
| S8 | [全部课表查询 chunk-50df0928.37589da2.js](https://my.cqu.edu.cn/tt/static/js/chunk-50df0928.37589da2.js) | `@26950` 逐课程、指定 sessionId 查询教学班 |
| S9 | [学校教师个人主页门户](https://faculty.cqu.edu.cn/) | 页面标注的是“开通人数”；不等于教务系统全体教师 |
| S10 | [学校教师主页学院列表页](https://faculty.cqu.edu.cn/xyjslb.jsp?PAGENUM=7&id=1011&lang=zh_CN&st=0&totalpage=82&urltype=tsites.CollegeTeacherList&wbtreeid=1002) | 具有分页，但其人口范围仍是教师主页系统 |

## 当前账号只读验证

业务层失败与 HTTP 状态分开记录。学校请求封装有时直接返回 `{status:"error", msg:...}`，此时不把这个字符串误写成 HTTP 状态，也不把失败的空 data 当成零教师。

| 路径 | 请求与结果 | 可以得出的结论 |
| --- | --- | --- |
| `GET /instructor/filter` | 姓名“张”，limitNum 为 5、10、20、30、50、100 时分别返回 5、10、10、10、10、10 条；空关键词、limitNum=0 返回 0 条 | 小上限生效，大上限未突破 10 条。不能说参数完全无效；不能据此分页遍历。[S1] |
| 同上，工号片段 | C013 返回 6 条；C013% 与 C013_ 得到同一组 6 条；C0130 精确匹配 1 条；013 返回截断的 10 条 | 支持片段与通配匹配，但没有代码全集、长度约束或总数，分片拼接仍不能证明无遗漏。[S1] |
| `GET /class/instructors/745004` | 业务成功，返回 1 位教师，含 instructorId、instrName、instrCode、instrDeptName；按其工号再次搜索，教师 ID 一致 | 可从已知教学班获取可用于订阅的教师标识；仅能推导这些班的任课教师。[S1] |
| `POST /class/replace-instructor/common-teachers` | 使用裸数组 `["745004"]`，业务返回“当前用户无操作权限” | 当前账号不能使用这个批量候选；没有扩大到多班请求。[S3] |
| `POST /instructor-arrange/list` | 学院为空时报“学院不能为空,”；学院与时间条件合法后可返回成功 | 这是有必填筛选条件的可调用列表。[S2] |
| 同上，覆盖对照 | 使用学院 finder 的全部 130 个 ID、sessionId=1061、idleFlag=true，返回 82 人，全部属于辛辛那提联合学院；单查该学院也是 82，单查软件学院为 0 | 实测结果只覆盖一个学院；权限或资源配置造成的具体过滤原因未确定。不能把成功响应解释为跨学院全量能力。[S2] |
| `POST /teacher-workload-statistic/list` | session=1061，dateStart=dateEnd=2026-10-15，currentPage=1,pageSize=20；5 秒预算及一次 20 秒预算均超时并取消 | 未确认可用，不能称为权限拒绝或零结果，也不拿它估计总人数。[S6] |
| `GET /class/classNbr-filter` | 空 courseNameOrClassNbr；limitNum=50 返回 50；10000 和 20000 都返回相同的 8461 个唯一 ID | 有可用的批量教学班目录路径，详见下一节。[S7] |

前一轮已验证的教师管理分页仍为：`GET /instructor/info/filter` 返回“当前用户无操作权限”；`GET /instructor-resource/page` 返回“操作失败”，后者失败原因未明确。没有重复用不同身份或角色尝试。[S4][S5][前轮记录](2026-10-15-external-directory-cache-discovery.md)

## 教师安排列表：可用范围与协议

第一方页面使用 JSON POST，字段包括 nameOrCode、deptIds、campusId、idleFlag。时间条件四选一：weekTime+week+periodFormat，weekTime+week+timeIn，date+periodFormat，date+timeIn。UI 默认学院来自当前用户的 departmentId。[S2]

实际成功查询示例：

```json
{
  "nameOrCode": "",
  "deptIds": ["114819107"],
  "idleFlag": true,
  "weekTime": "5",
  "week": 4,
  "startPeriod": 6,
  "endPeriod": 9,
  "periodFormat": "6-9",
  "date": "",
  "timeIn": "",
  "sessionId": "1061",
  "currentPage": 1,
  "pageSize": 20
}
```

该次返回 82 条，说明 pageSize=20 没有把这个数组限制成 20 条分页。返回字段有 name、code、deptId、deptName 和时间安排字段，**没有 instructorId 或 totalElements**。研究输出仅统计目录字段；未保存个人课表或其他原始安排明细。

固定时间点的“安排”和“空闲”并集，只有在二者被证明覆盖同一个完整教师总体时才可视为全集。本轮所有学院的“安排”对照为空，“空闲”只有单学院 82 人；既没有独立总数，也没有跨学院覆盖证据，因此不满足这个证明条件。不要因为 SQL/业务成功就将其升级为全校目录。

## 新发现的教学班批量目录

[S7] 的实际搜索代码：

```js
case "教学班":
  this.url = `${n["E"]}/classNbr-filter?courseNameOrClassNbr=${e}&limitNum=${this.limitNum}`;
  this.baseHttp = n["X"];
```

[S1] 共享常量确认 `E=/class`，`X=https://my.cqu.edu.cn/api/timetable`。因此真实入口为：

```text
GET /api/timetable/class/classNbr-filter?courseNameOrClassNbr=&limitNum=10000
```

- 10000 上限：8461 条，8461 个唯一 ID，约 991ms。
- 20000 上限：同样 8461 条，ID 集合完全一致。
- 只含目录字段：id、classNbr、courseName、courseCode。
- 先前均匀抽样的 10 门课程，指定 sessionId=1061 后返回 16 个教学班；这些 ID 全在批量目录中，其中一门课程合法返回空列表。[S8]
- 没有独立总数；未验证跨学期切换、是否含历史或未开课教学班。当前证据支持“稳定取得当前账号可见的批量候选集合”，不支持“已独立证明全校当前学期全集”。

### 课程编码映射不能直接沿用旧快照

比对发现，旧课程快照使用的 code（例如 24008）与教学班目录 courseCode（例如 SE7A007）不一致，直接按这两个字段连接会错误地认为所有样本缺失。

对“计算智能理论及应用”的课程接口进行当前查询，课程对象 `id=10000000447` 的 `codeR=SE7A007`，与教学班目录相符；另一个同名课程有不同的 id 和 codeR。因此不能只按名称连接。若以后用批量教学班目录预填课程选择器，需在课程目录中保留 codeR，并对整个课程集合验证 ID/codeR/教学班映射。这里只验证了一个课程查询的字段契约，未完成全部映射校验。

这使此前“必须每周逐门查询 3800 次才能获得教学班名单”的说法失效：已存在只需少量请求取得批量候选的路径。若要从教学班进一步推导教师，目前可用的逐班 `/class/instructors/{id}` 仍需额外请求；批量 common-teachers 已被拒绝，而且任何课程推导都无法证明包含未任课教师。

## 其他办法为什么尚不能满足全量

- **公开教师主页**：学校门户显示“开通人数 1525”，学院列表页显示自己的分页总数 1234。它们描述不同页面范围，不能相加，更不能作为教务系统教师总数。页面未给出与 timetable instructorId 的完整映射。[S9][S10]
- **工号/姓名分片**：普通搜索有 10 条上限，已知片段能命中更多人，但没有可证明覆盖所有工号格式、空工号、外聘与历史编码的分区方案；不将枚举得到的零散记录称为完整名单。
- **课程/教学班反推**：可查到有效教师 ID，但定义上仅包含所查询班级中的教师。即使教学班全集完整，也不包含从未排入这些班级的教师。[S1][S8]
- **管理页面导出**：S4 显示 `/instructor/info/excel` 使用与列表相同的筛选对象，尚未验证可用性；没有为取得名单而下载包含其他个人字段的整张师资档案导出。
- **凭空猜测 URL**：现有脚本未给出 instructor/name-code-search 或 instructor/finder 一类入口，不把名称猜测写成事实。本轮仅验证源代码实际存在的接口。

## 验收与实施边界

**后续决定：** 用户已同意从这 8,461 个教学班反查教师，只需覆盖本学期有课的教师，并要求每周更新、请求分散执行。下述完整人事名册标准属于此前研究范围，已经不再阻止实施；最新方案见[每周共享目录](2026-10-15-weekly-external-directory.md)。历史教学班对照的新增证据也记录在新方案中。

教师全量来源需要可核验的范围：例如授权列表的总数与分页 ID 集合一致，或学校明确提供完整名单及稳定教师 ID/工号映射。取得某一学院的 82 人、课程任课教师并集、或个人主页名单，都不能代替这一条件。

本轮未实施生产缓存。当前可继续推进的研究重点，是取得与当前账号可搜索教师总体一致、带独立总数或可证明遍历边界的来源；如使用其他学校账号或官方文件，须本来就具备相应读取授权。没有修改权限、替换其他用户会话或绕过访问限制。

## 本地证据文件

研究输出目录：

`/Users/uu/.codex/visualizations/2026/10/15/01a13d16-e20e-72d3-b236-d4583af958d3/external-directory-research/`

- `teacher-alternatives-probe-summary.json`：35 条脱敏探针记录，含参数、耗时、业务结果、计数和字段名称；不保存原始响应或凭据。
- `teaching-class-directory-snapshot.json`：8461 行教学班最小目录字段，带覆盖范围声明。
- `teaching-class-comparison-result.json`：10 门课程的 16 个班级 ID 与批量目录的包含关系；同时记录两个接口课程编码不同。
- `public-js/`：上述第一方脚本快照，新增 S6、S7 对应文件。

结果未提交或推送。这里只完成研究，不把本地已有数据当作已上线共享缓存。
