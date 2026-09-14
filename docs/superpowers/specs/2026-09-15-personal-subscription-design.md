# 个人订阅合并：后端单订阅，前端三视图

日期：2026-09-15。目标仓库：`cqu-moe/schedule-cloudflare`。

## 用户已确定的边界

- 全部、课程、考试在后端是一项特殊的个人订阅，一次同步、一个 runId、一份同步状态、一个手动同步 CD。
- 用户有 `calendar.sync` 权限就自动获得三个展示，不再选择个人订阅类型。
- 个人订阅不能由用户添加、删除或改变类型、身份、视图数量。此规则同时适用于三种旧类型和新的内部类型。默认三个内置视图不可改名或删除，普通分享链接的现有管理能力仍然保留。
- **三张卡片展示保持原状，只移除个人订阅删除入口和确认界面。** 用户先选择前端完全不动，随后明确补充“前端把删除页面删了就好”。以最后补充为准：不重构卡片、store、API 类型、计数或添加页面；个人删除菜单不显示，确认函数对个人项也不能进入。外部订阅删除保留。
- 本轮只写设计和计划。实施交给 **5.6-sol，high**。不实施业务代码、不推送、不部署、不执行生产数据迁移。

## 证据及本次替代范围

来源：[cqu-moe/auth #12](https://github.com/cqu-moe/auth/issues/12)，2026-09-15 读取，open、无评论。其 Schedule 部分原要求按用户合并 Cron 入队并将一次 harvest 写入各个人订阅。本设计替代这部分的“三订阅协调”方案。Auth 的 DO 重启恢复、验证码 owner 和容器诊断属于该 issue 的其他工作，本计划不改 Auth，不宣称整个 issue 已解决。

代码基线为远端 `main` 的 `6cef19a7781169b7409e46b37723578486e559d0`。用户主 checkout 停在 `543d0f1`，有无关未跟踪文件；本计划在独立 worktree `.worktrees/personal-subscription-plan` 编写。

当前实现：

- `src/db/schema.ts` 将三种个人类型作为三个 subscription，分别储存数据和状态。
- `src/services/personal-subscription-setup.ts` 创建三行；有任意旧订阅或初始化记录就跳过；要求至少三个额度。
- `src/routes/v2/subscriptions.ts` 手动同步查出三行、选 cooldown owner，再写三行；返回三个 affected IDs。
- `src/cron/schedule-sync.ts` Cron 逐 subscription 分配 runId。消费者只在一个 batch 内按用户缓存 harvest，并向其他个人记录写入数据；不匹配 runId 的记录还能通过无 runId 的写入路径被更新。
- `src/routes/v2/calendar.ts` 按 token 联表后直接输出 subscription 的内容；合并后必须增加视图筛选。
- `frontend/src/views/Dashboard.vue`、store 和 API 类型依赖三个独立展示 ID。`count` 由数组长度计算。`Add.vue` 仍有三种选择，删除错误会通过已有 toast 展示。

## 方案选择

采用 **一个真实 subscription + 三条无同步状态的兼容视图映射**。真实记录负责权限、配额、调度、数据与同步状态；映射只负责旧 ID、名称和导出范围。后端 API 展开为现有三条响应，前端无需理解新模型。

不采用“三行加 groupId”，因为那仍需协调三份状态。不采用“API 返回一行，由前端展开”，因为用户要求保留前端展示逻辑，仅移除个人删除入口。

## 数据模型

### 真实订阅

`subscriptions.source_type='personal'`，`source_id=user_id`，`is_personal=1`。部分唯一索引约束每个 `user_id` 至多一行 personal。`user_id` 是 Auth 稳定用户 ID，不是邮箱或学号。

现有 `courses_json`、`exams_json`、学期信息、`last_synced_at`、`manual_refresh_at`、`sync_*` 都只存在于真实订阅。一次成功写入更新整份课程和考试快照；失败不覆盖有效快照。

新增 `sync_execution_token TEXT`、`sync_execution_until INTEGER NOT NULL DEFAULT 0` 作为同一 run 的消费执行权。它们不对前端暴露。

### 兼容视图

新增 `personal_subscription_views`：

| 字段 | 约束/用途 |
| --- | --- |
| `id` | 主键。已有视图保留原 subscription ID；缺失视图使用新 UUID |
| `subscription_id` | 外键指向真实 subscription，删除父项时 cascade |
| `source_type` | CHECK 限定 personal_all / personal_courses / personal_exams |
| `source_name` | 保留原卡片名称；新视图使用现有三个默认名称 |
| `created_at` | 保留原展示顺序依据 |

唯一约束 `(subscription_id, source_type)`。此表不含同步状态、CD、权限、配额或课程考试 payload，调度器不得扫描它产生任务。真实 ID 可以与 all 视图 ID 相同；路由先按视图解析并校验 owner，再处理外部 subscription。

`calendar_links` 新增 `personal_view_type TEXT NULL`，枚举相同。个人链接 FK 指向真实 subscription，`personal_view_type` 决定数据范围；外部链接为 NULL。保留 token、link ID、label、formats、is_default、时间戳。每个个人视图恰好一个默认链接，而非整个 personal 只有一个。

## 自动提供与权限

`GET /api/v2/subscriptions` 在已认证的用户范围内执行幂等 ensure，然后序列化。继续支持 `POST /defaults`，两者调用同一个 ensure/dispatch 服务。首次登录、普通 Dashboard 刷新、只有外部订阅的旧用户、部分旧个人订阅、历史删除记录、后续权限开通都不能再被“已有 setup”永久跳过。

- `caps.sync=true`：自动确保一行 personal、三个视图、各一个默认链接。此项由权限授予，不因 `sub_limit=0` 或已满而拒绝初始化。业务配额统计只计一条真实记录，其他订阅的新增继续遵守原总额度。允许权限提供的固定项使历史总量高于额度，不删除旧数据。
- `caps.sync=false`：不创建新的个人订阅；已存在的真实订阅停用，链接继续按现有 inactive 规则拒绝；不删除记录。恢复权限后复用原 ID 和 token。
- CQU `active`：在没有已接受快照、没有活跃 run 时申请 initial 同步。失败之后由现有手动重试和 Cron 恢复，不因每次 GET 重复开新 run。
- CQU 明确未绑定：允许自动提供记录与三个展示，但不抓取。无旧数据的新记录共享 `error / CQU_BINDING_REQUIRED`，消息为“请先绑定重庆大学统一认证账号”，使现有首次同步 UI 不会一直显示准备中。
- CQU 状态未知：不尝试抓取，不猜测未绑定。无旧数据的新记录共享 `error / CQU_BINDING_STATUS_UNKNOWN`，消息为“暂时无法确认统一认证绑定状态”。下次权威状态 active 时可启动首次同步。
- 以上绑定状态错误不改变已有有效数据的 freshness。绑定返回 active 后只针对未获得过有效快照的记录恢复 initial 流程；其余使用现有手动/Cron 路径。
- GET 的自动写入仅为用户权限派生资源的幂等补齐；响应使用 private/no-store，不能由公开日历 token 路由创建新个人订阅。

`personal_subscription_setup` 继续用于首次展示和初次消息投递恢复。`subscription_ids` 保存三个视图 ID，`run_id` 为共享 run；历史 `existing` 标记不再阻止 ensure。`dispatch_status` 不是第二份同步状态，仅表示 initial 消息投递结果。

## HTTP 兼容合同

保持现有 JSON 的字段、错误 envelope 和旧 source_type，不向前端返回内部 personal 类型。

| 入口 | 行为 |
| --- | --- |
| GET 列表 | 一个 personal 展开为原来的三项；三项共享 sync_*、manual_refresh_at、last_synced_at，各自保留 ID、名称、类型、links |
| GET `/:sid` | 旧个人视图 ID 解析为 canonical 后投影；跨用户和未知 ID 返回 404 |
| POST `/:sid/syncs` | 任一视图解析到同一 canonical。一次被接受的刷新只入队一条消息；返回原 `202`、run_id、三个 affected_subscription_ids、同一 cooldown_until |
| POST `/defaults` | 幂等 ensure，保持 created/resumed/existing/skipped 合同与三个 subscription_ids |
| POST `/` 个人类型 | `403 PERSONAL_SUBSCRIPTION_MANAGED`，消息“个人课表由系统自动提供，无需手动添加” |
| DELETE `/:sid` 个人视图或 canonical | `403 PERSONAL_SUBSCRIPTION_MANAGED`，消息“个人课表由系统自动提供，无法删除” |
| `/:sid/links` 全部方法 | 先校验视图 owner，只能访问该视图的 links；新增分享链接继承路径视图，不能由 body 改大数据范围 |
| 默认链接 | 保留现有不可修改/不可删除与可轮换 token 的规则 |
| 外部订阅 | 保持原创建、删除、额度、冻结与权限行为，不接入个人 harvest |

列表 `count` 继续表示返回条目数量，使 v2 合同与现有 UI 一致。后端计费/额度查询使用真实 subscriptions 行数。已知限制：前端计数与 atLimit 仍按三张卡片计算，可能提前阻止用户点击外部添加；本次不得改 caps 欺骗前端，也不得调整前端来修正它。此限制由“保持展示逻辑，仅移除个人删除入口”的边界产生。

## 同步与并发

所有 producer 使用同一条 canonical 行进行条件更新。手动接受时，将 manual_refresh_at、runId、queued 状态和时间戳放在同一条条件 UPDATE 中，不再选三行中的 owner。保留 **5 分钟** CD 和现有按中国日期统计的 daily manual_refresh 软配额。

活跃任务定义保留当前的 queued/running 且 sync_requested_at 未超过 **2 小时**。任一入口遇到活跃任务都复用它，不能覆盖 runId、重复 send 或消耗手动额度。手动入口仍先执行权限和 manual_refresh=0/已用完检查；在有效 CD 内返回现有 429 CD 错误。CD 已结束但旧任务仍活跃时返回该 run 的兼容 202，不重置 CD、不扣次数。Cron 并发运行也只能有一个 claim 获胜。

Queue 消息只携带真实 subscriptionId、userId、runId、trigger。旧 view ID 的消息在兼容期先解析；旧 runId 失效后 ack，不允许转换为当前 run 再执行。新消息必须有 runId；legacy 无 runId 消息在迁移后个人记录上 ack，等待正常 producer 恢复。

Cloudflare Queue 为至少一次投递。同 run 消费者用 D1 条件 UPDATE 取得执行 token，最长 **15 分钟**租约；当前 harvest 总 deadline 为 **13 分钟**，必须共用原绝对 deadline。未到期的重复消息延迟到租约后检查；过期可用新 token 接管。数据、success/error/retry、lease 清除都必须同时匹配 canonical ID、runId、execution token。旧 owner 即使迟到也不能修改新 owner 的结果。租约不保证学校系统在进程异常时绝对只收到一次请求，但保障唯一有效结果提交。

成功路径只写一条真实订阅，且 guarded update 确实修改一行后才处理变更通知。通知保持现有去重键和首次基线规则。停止向 sibling subscriptions fan-out，停止无 runId 的个人数据写回。

现有 45 分钟容量等待预算、30/120/300 秒一般失败重试、外部 freeze、权限复核、错峰入队保留。initial 投递继续用已有 durable dispatch 恢复；普通同步发送失败设 QUEUE_UNAVAILABLE，手动失败只按当前 run 条件释放 CD。D1 与 Queue 不是同一个事务，发送结果不确定时允许重复投递，由 run 和 lease 做幂等处理。

## 导出与数据范围

所有五种格式都先根据存储的 `personal_view_type` 选择课程/考试数据，再调用现有 exporter。all 包含两者，courses 永不含考试，exams 永不含课程。格式权限检查和数据视图检查是两层独立限制。URL query 不得覆盖 link 的视图。

个人 ICS 在投影层使用现有 generateCoursesIcs / generateExamsIcs / mergeIcs，命名空间继续用稳定 user/source ID。空考试输出现有 EMPTY_ICS；JSON 中对应空数组；已成功同步的空数组是有效数据。外部 ICS 保留缓存直出。

保留 `/api/v2/calendar/<token>/...` 及网页预览地址、格式 allow-list、默认链接轮换行为。缓存仍按完整 token URL 区分，不用 canonical ID 作为不同视图的共同 cache key。

## 迁移及发布顺序

先做只增加 schema 的迁移，兼容代码必须能读旧三行和新模型；旧行在转换前继续走旧格式输出。另设默认关闭的 `PERSONAL_SUBSCRIPTION_V2` 服务端开关控制新建/转换/新调度，代码部署完成并确认旧版本 consumer/request 已退出后才允许启用。开关关闭不能将已转换用户退回旧 fan-out；遇到 canonical 时始终按新模型读取和处理。

第二阶段由操作者执行一次性迁移，覆盖数据库中所有已有个人订阅的用户，含只剩一个或两个类型者；不依赖他们重新登录。按用户使用一个 D1 batch 完成以下操作；batch 中途失败必须完整回滚。迁移脚本必须有 dry-run、逐用户进度记录、幂等续跑和最终验收，默认只 dry-run，实际执行需显式 --apply。迁移只补足固定类型，不由用户选择。

1. 选 canonical ID：优先旧 personal_all，否则按 created_at、id 选最早一行；所有旧展示 ID 保存在 views。
2. 将旧行完整快照写入只用于迁移恢复的 `personal_subscription_migration_backups`，不可被生产同步器读取或用于重新提供旧链接。保留原 payload，避免自动丢弃较旧学期或不一致副本。
3. 选择最新的成功数据学期作为主快照，按同一学期分别取最新可用课程和考试；不能将不同学期的课程拼接。personal_all 中成功的 null exams 代表无考试，不能拿更早考试回填。只有 courses 的旧用户保留课程并将缺少 exams 标为未完成首次整体同步；只有 exams 同理。任何丢失的原始副本仍在备份中。
4. 为原有类型创建映射，缺失类型补齐。移动每条 link 的 FK 并标注原视图类型，再删除多余订阅行；不得先删除父行触发 FK cascade 丢失 token。
5. 将 survivor 改为 personal，唯一化 user/source，并保留最新 manual_refresh_at。完整快照的 freshness 取参与数据中最早时间；不完整快照置 last_synced_at=NULL，不伪装为完整同步成功。
6. 作废旧 runId，清空执行权和旧 initial dispatch 租约；更新 setup 中三个 view IDs。旧数据完整时记现有状态并由正常 due 判断启动下一次同步；数据不完整时设 error/PERSONAL_SYNC_REQUIRED、last_synced_at=NULL，在新代码恢复调度后按 binding/caps 校验进入 initial 或 Cron。迁移期间不向 Queue 发送消息。
7. 每个视图确保恰好一个默认链接，保留已存在的 token；如果旧数据有多个默认链接，固定保留最早一个为默认，其他原样 token 降为可管理链接，并在迁移报告统计这类异常。

一次性迁移验收要求旧 personal_all/courses/exams 实体记录归零，每个迁移用户恰好三个视图，所有旧 token 都可解析。在此之前保持兼容代码和 migration gate，旧 personal 同步/修改暂停以免并发写入；公开旧 token 仍可读取旧数据。迁移成功才启用新个人创建和调度。此后 GET/defaults 根据当前权限自动确保固定资源；已有外部订阅但从未有个人记录、从未访问的用户，首次访问时创建。不得把存量补齐改成“等用户回来再迁移”。普通 GET 不运行旧数据迁移器。

迁移 dry-run 输出只包含计数、冲突类别和检查结果，不输出 token、课程、考试、凭据。旧行、链接总数、视图计数和 FK 完整性必须在离线 fixture 与 D1 测试验证。回滚使用已部署的兼容版本加关闭新转换开关，不能只回滚到旧三行代码。逆迁移须先备份新增数据、处理新链接，并另获生产操作授权。

D1 batch 的失败回滚及 FK cascade 行为依据 [D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) 和 [D1 外键文档](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)，本轮经 Context7 查询官方文档源码确认。

## 验收

- D1 每个 eligible 用户一条 personal，三个无状态视图；首次、并发、旧 setup、历史删除、满额度、部分旧类型均满足。
- 不依赖 setup=1 即可在现有前端显示三个订阅；未绑定和未知绑定不会产生假成功或无穷初始化。
- 任一卡片或顶部同步按钮只接受一个 run；三份 API 展示的状态、CD、错误、freshness 一致。
- 并发手动、手动/Cron、重复 Cron、跨 batch 同 run、租约接管、旧 run 迟到都有数据库支持的回归测试。
- 失败不改有效数据；一次成功原子更新两类数据；过期 token 的执行者不发送变更通知。
- 旧个人 ID、token、所有导出格式和分享链接的 view scope 保留；禁止 courses token 获取 exams，反向同样禁止。
- 个人添加/删除均由 API 拒绝；默认链接保护、用户 owner 校验与外部冻结继续成立。
- 前端变更仅允许 `frontend/src/views/Dashboard.vue` 的个人删除入口/确认守卫和对应 `frontend/src/views/__tests__/Dashboard.test.ts`。卡片结构、展示逻辑、添加页面、store、API 类型、计数与同步反馈不改；复用现有前端跑测试和浏览器验证。
- 本轮只产出文档。后续本地测试、部署、生产 D1、Queue、真实账户验收分别报告，不互相替代。
