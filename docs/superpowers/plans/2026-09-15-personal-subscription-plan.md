# Built-in personal subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将每个用户的个人课程/考试变成一条真实订阅，固定向前端提供三个视图；一次按钮点击发送一次个人同步请求，后台只同步该记录。

**Architecture:** `subscriptions` 储存一条 `personal`，`personal_subscription_views` 只保留旧展示 ID 和视图类型。API 兼容层仍返回三张卡片，Queue 只处理真实 subscription ID。存量用户通过一次管理员操作分批完整迁移，不等待重新登录。

**Tech Stack:** TypeScript、Hono、Drizzle、Cloudflare D1/Queues/KV、Vue 3/Pinia、Vitest/workerd。沿用现有依赖，不新增锁服务或调度框架。

**Spec:** `docs/superpowers/specs/2026-09-15-personal-subscription-design.md`，执行前完整阅读，与本计划一起交付。

## Global Constraints

- 全部、课程、考试在后端是一项特殊的个人订阅，一次同步、一个 runId、一份同步状态、一个手动同步 CD。
- 用户有 `calendar.sync` 权限就自动获得三个展示，不再选择个人订阅类型。
- 本次交付是单订阅数据模型，不能降级为同步并发修复。
- 保留 5 分钟手动 CD、2 小时活跃 run 判断、45 分钟容量等待预算、30/120/300 秒一般失败重试与 13 分钟 harvest 绝对 deadline。
- 不新增执行租约字段、不重做 Auth 登录锁、不恢复外部 harvest、不改依赖版本。
- 前端只修改个人同步调用和个人删除入口。三卡片的结构、名称、样式、store、响应类型、计数与同步反馈保持原状。
- 个人资源不能由用户添加、删除、改类型、改身份、改名或改变视图数量。默认链接保留当前保护规则；普通分享链接继续可管理。
- 旧视图 ID、旧 token、链接格式范围和课程/考试隔离必须保留。不可先删父记录导致链接被 FK cascade 删除。
- 实施由用户选择的 **5.6-sol / high** 完成。本轮止于计划；后续执行不得把此计划视为 push、部署、生产迁移或发邮件授权。
- 工作基线 `6cef19a7781169b7409e46b37723578486e559d0`。当前文档 worktree 为 `/Users/uu/Developer/cqu-moe/schedule-cloudflare/.worktrees/personal-subscription-plan`，分支 `codex/personal-subscription-plan`。已有隔离，无需创建第二个 worktree。
- 每次提交先检查有效 `git config user.name` 与 `git config user.email`；不覆盖身份。仓库 `git push` 可触发 Cloudflare Git Connector，未获上线授权不要 push。

---

## 先读这些事实

`Dashboard.vue::handleSyncAll` 当前已只发一次 `api.refreshSubscription(target.id)`。后面的 affected IDs 遍历是本地状态更新，不是三次 HTTP 同步。旧后端手动同步仍查三条记录、选 CD owner、批量写三个 run；Cron 逐记录开 run，消费者向 sibling fan-out。此次必须消除后三种存储/调度行为。

`src/routes/admin.ts::POST /refresh-all` 也扫描 subscriptions，目前发没有 runId 的消息，必须跟着收敛。`src/services/personal-subscription-setup.ts` 的“任意 subscription 已存在即跳过”“历史 setup 永久跳过”“额度必须 >=3”全部不再适用。

列表仍返回三项且 `count=3+外部项数量`；后端 quota 统计真实行数。前端 store 自己按卡片数量算 atLimit，保留这一已知限制，不改 caps 欺骗前端，不在此任务顺带调整计数。

## 执行前置检查

执行者先核对 `git status --short --branch`、`git log -1 origin/main` 和 AGENTS.md，确认文档 worktree 仍是隔离工作区。缺依赖时使用根目录和 frontend 各自 lockfile 运行 `npm ci`，然后在改业务代码前运行 `npm test`、`npm run typecheck`、`npm --prefix frontend test` 并记录基线。保存现有桌面/手机三卡片截图用于 Task 9 比较。此文档编写轮次未安装依赖或运行应用测试。

## 文件职责与任务依赖

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `src/db/schema.ts`, `drizzle/migrations/0011_personal_subscription_views.sql` | personal 唯一实体、视图映射、链接范围、迁移备份 | 1 |
| `src/services/personal-subscription-views.ts` | 固定定义、owner 解析、原格式 API 投影 | 2 |
| `src/services/personal-subscription-setup.ts`, `personal-setup-dispatch.ts` | 幂等自动提供、一次 initial 投递 | 3 |
| `src/services/sync-status.ts`, `src/services/personal-subscription-sync.ts` | 原子申请/启动任务、共享 CD、个人专用申请与执行链路 | 4、5 |
| `src/cron/schedule-sync.ts`, `src/services/sync.ts`, `src/routes/admin.ts` | Cron/consumer/admin 只处理 canonical | 5 |
| `src/routes/v2/subscriptions.ts`, `calendar.ts`, `src/services/personal-calendar-projection.ts` | 兼容路由、链接 scope、五格式投影 | 2、4、6 |
| `src/services/personal-subscription-migration.ts`, `src/routes/admin.ts` | 手动一次性转换存量及验收 | 7 |
| `src/types.ts`, `wrangler.jsonc`, `src/config/personal-subscription-mode.ts` | 三阶段迁移模式 | 1、7 |
| `frontend/src/views/Dashboard.vue`, `frontend/src/api/index.ts` | 一个个人同步请求，个人删除入口移除 | 8 |
| `docs/operations/personal-subscription-migration.md` | 部署/迁移操作单，单独授权后执行 | 7、9 |

顺序执行 1→2→3→4→5→6→7→8→9。测试/配置随对应交付一起完成；不把“搭架子”单独提交成不可验收的成果。第 1–7 项兼容代码在迁移模式控制下共存，最终验收以 enabled 模式和已转换数据为准。

### Task 1: 实体 schema、迁移开关和真实 D1 fixture

**Files:**
- Modify: `src/db/schema.ts`, `src/types.ts`, `wrangler.jsonc`, `vitest.config.ts`
- Create: `drizzle/migrations/0011_personal_subscription_views.sql`, `src/config/personal-subscription-mode.ts`, `src/db/personal-subscriptions.test.ts`, `tests/fixtures/personal-subscriptions.ts`, `tests/env.d.ts`
- Update fixtures in: `src/routes/v2/subscriptions.test.ts`, `src/routes/v2/calendar.test.ts`, `src/services/personal-subscription-setup.test.ts`, `src/services/personal-setup-dispatch.test.ts`, `src/cron/schedule-sync.test.ts`, `src/cron/schedule-sync.harvest.test.ts`, `src/cron/schedule-sync.external-guard.test.ts`

**Interfaces:**
- `SourceType` adds `personal`; keep legacy personal types as `PersonalViewType` for transport/migration compatibility.
- `PersonalViewType = 'personal_all' | 'personal_courses' | 'personal_exams'`.
- Export `personalSubscriptionViews`, `personalSubscriptionMigrationBackups` and inferred row types.
- `personalSubscriptionMode(env: Pick<Env, 'PERSONAL_SUBSCRIPTION_MODE'>): 'legacy' | 'migration' | 'enabled'` rejects unexpected configured values; absent means legacy.
- Test helper `seedPersonal(db: D1Database, userId: string): Promise<{id: string; viewIds: string[]}>` inserts one personal, three views and three synthetic default tokens. `readPersonalRows(db,userId)` returns real subscription rows, not projections. `resetPersonalData(db)` deletes links, views, backup rows, setup then subscriptions in FK-safe order.

- [ ] 写真实 D1 约束测试。先断言第二条同 user personal 插入失败，另一个 user 可以插入；一个 canonical 可以三个不同 views、重复 type 拒绝；外部 link scope 是 NULL；个人非法 scope 拒绝。

```ts
it('allows one canonical per user and three distinct views', async () => {
  const first = await seedPersonal(env.DB, 'u-one');
  expect(await readPersonalRows(env.DB, 'u-one')).toHaveLength(1);
  await expect(env.DB.prepare(`INSERT INTO subscriptions
    (id,user_id,source_type,source_id,source_name,created_at,updated_at)
    VALUES ('duplicate','u-one','personal','u-one','个人课表',?,?)`)
    .bind(now, now).run()).rejects.toThrow();
  const views = await env.DB.prepare(
    'SELECT source_type FROM personal_subscription_views WHERE subscription_id=?',
  ).bind(first.id).all();
  expect(views.results.map(v => v.source_type).sort()).toEqual([
    'personal_all', 'personal_courses', 'personal_exams',
  ]);
});
```

`now` 在该测试文件定义为 `new Date().toISOString()`。fixture 使用 crypto.randomUUID 创建非敏感假 ID；源数据采用后续 Task 6 的课程/考试 fixture。

- [ ] 运行 `npm test -- src/db/personal-subscriptions.test.ts`，确认缺表/缺约束导致失败。
- [ ] 增量迁移只加结构，不转换生产行。SQL 的主体如下；Drizzle schema 必须声明相同 CHECK/unique/FK。

```sql
CREATE UNIQUE INDEX uq_personal_subscription_user
  ON subscriptions(user_id) WHERE source_type='personal';
CREATE TABLE personal_subscription_views (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN
    ('personal_all','personal_courses','personal_exams')),
  source_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(subscription_id,source_type)
);
ALTER TABLE calendar_links ADD COLUMN personal_view_type TEXT
  CHECK(personal_view_type IS NULL OR personal_view_type IN
    ('personal_all','personal_courses','personal_exams'));
CREATE INDEX idx_calendar_links_personal_view
  ON calendar_links(subscription_id,personal_view_type);
CREATE TABLE personal_subscription_migration_backups (
  user_id TEXT PRIMARY KEY NOT NULL,
  subscriptions_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  setup_json TEXT,
  migrated_at TEXT NOT NULL
);
```

- [ ] `Env` 新增可选 `PERSONAL_SUBSCRIPTION_MODE?: 'legacy'|'migration'|'enabled'`，wrangler vars 明确默认 `legacy`。不添加 sync execution lease 列。
- [ ] 新 D1 测试以真实 migrations 创建 schema。已安装包已核对有 `readD1Migrations()` 和 `applyD1Migrations()`；在 config 中读取 migrations 并通过 `TEST_MIGRATIONS` binding 传入，在测试 `beforeAll` 调用 `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`。保留已有 AUTH service stub。在 `tests/env.d.ts` 声明 Cloudflare `ProvidedEnv` 的 DB 与 migrations。原有手写表 fixture 加新表或改为调用这套 helper，禁止一边删表一边保留旧 `d1_migrations` 记录导致假成功。
- [ ] 运行 schema 测试及七个受影响测试文件，记录因预期业务改变暂时失败的断言，schema/fixture 本身必须通过。`npm run typecheck` 通过。
- [ ] 检查 migration 编号未与更新后的 main 冲突；按仓库当前 0008–0010 手写 SQL 方式维护，不能让 drizzle-kit 重放旧迁移。提交 `feat(schedule): add canonical personal subscription schema`。

### Task 2: 三个无状态视图与原 API 兼容

**Files:**
- Create: `src/services/personal-subscription-views.ts`, `src/services/personal-subscription-views.test.ts`
- Modify: `src/routes/v2/subscriptions.ts`
- Test: `src/routes/v2/subscriptions.test.ts`

**Interfaces:**

```ts
export const PERSONAL_VIEWS = [
  { sourceType: 'personal_all', sourceName: '我的全部课表' },
  { sourceType: 'personal_courses', sourceName: '我的课程' },
  { sourceType: 'personal_exams', sourceName: '我的考试' },
] as const;
export type ResolvedOwnedSubscription = {
  subscription: Subscription;
  view: PersonalSubscriptionView | null;
};
export function resolveOwnedSubscription(
  db: D1Database, userId: string, sid: string,
): Promise<ResolvedOwnedSubscription | null>;
export function listPersonalViews(
  db: D1Database, subscriptionId: string,
): Promise<PersonalSubscriptionView[]>;
```

`Subscription` 和 `PersonalSubscriptionView` 从 schema 导出；`resolveOwnedSubscription` 先查询视图联真实记录并校验 owner，未命中再查实体以支持外部/管理员 canonical。序列化函数 `serializePersonalView(subscription, view, links)` 的返回类型沿用原 `serializeSubscription` 响应加 links，不引入新的前端响应形状。

- [ ] 在 routes 已有 `buildApp(userId,caps,binding)`、`jsonBody()` fixture 上写测试：一条 personal 返回三条旧 source_type；设置真实行 sync_status/runs/CD 后三条字段一致；非个人项只返回一次；用户 B 查用户 A 的任一视图均 404。

```ts
const owner = await seedPersonal(env.DB, 'userA');
const app = buildApp('userA');
const response = await app.request('/');
const result = await response.json();
expect(result.subscriptions.map(s => s.id).sort()).toEqual(owner.viewIds.sort());
expect(new Set(result.subscriptions.map(s => s.sync_run_id)).size).toBe(1);
expect(result.subscriptions.some(s => s.source_type === 'personal')).toBe(false);
expect((await buildApp('userB').request(`/${owner.viewIds[0]}`)).status).toBe(404);
```

- [ ] 运行 `npm test -- src/services/personal-subscription-views.test.ts src/routes/v2/subscriptions.test.ts` 看新断言失败。
- [ ] 将 `GET /`、`GET /:sid` 改为从实体状态投影；每张视图只附该 `personal_view_type` 的 links。`count` 等于返回长度；旧未转换数据在 legacy/migration 模式保持原序列化。旧 ID 与 canonical ID 相等时先解析 view，不能直接把 all 卡片的 links 变成三个视图的全部 links。
- [ ] 更新 `ownedSubscription`、`linkOfSubscription` 的调用方传递解析结果，后续 Task 6 使用 canonical ID + view type 校验；外部使用 view=null。
- [ ] 运行测试通过并提交 `feat(schedule): project one personal subscription into existing views`。

### Task 3: 权限自动提供与首次同步恢复

**Files:**
- Modify: `src/services/personal-subscription-setup.ts`, `src/services/personal-setup-dispatch.ts`, `src/routes/v2/subscriptions.ts`
- Test: `src/services/personal-subscription-setup.test.ts`, `src/services/personal-setup-dispatch.test.ts`, `src/routes/v2/subscriptions.test.ts`

**Interfaces:**
- Extend `prepareDefaultSubscriptions(env,userId,caps,bindingStatus)` with `bindingStatus: CquBindStatus | undefined` from trusted session; return existing `DefaultSubscriptionsResponse` containing three view IDs.
- `dispatchPersonalSetup(env,userId)` still dispatches initial only, selecting one `source_type='personal'` matching setup.run_id.
- Both authenticated `GET /` and `POST /defaults` call the same ensure service in enabled mode. A GET never calls migration service.

- [ ] 将“三条实体”测试改为下面合同，并保留并发幂等、投递失败、租约过期恢复测试。

```ts
const caps = { ...FULL_CAPS, sub_limit: 0 };
const first = await prepareDefaultSubscriptions(setupEnv, 'userA', caps, 'active');
const second = await prepareDefaultSubscriptions(setupEnv, 'userA', caps, 'active');
expect(await readPersonalRows(env.DB, 'userA')).toHaveLength(1);
expect(first.subscription_ids).toHaveLength(3);
expect(second.subscription_ids).toEqual(first.subscription_ids);
expect(second.run_id).toBe(first.run_id);
```

额外 fixture：只有 external、历史 setup(existing,[])、历史删空、caps.sync=false、binding active/unbound/unknown。前四种有权限者必须自动提供，后两种绑定错误要持久化共享错误而不调用 Queue。

- [ ] 运行 `npm test -- src/services/personal-subscription-setup.test.ts src/services/personal-setup-dispatch.test.ts` 确认失败点是旧三行/旧 skip/旧 quota。
- [ ] 一个 D1 batch 创建 canonical + 三个 views + 三个默认 links + setup。依靠唯一 user 索引使并发初始化只有一个胜者，失败者重读已提交完整结果，不生成替代 token。已存在 canonical 时校验补齐内置资源，setup 仅管理 dispatch，不能成为跳过资源的理由。
- [ ] 新建绑定 active 的记录只有一份 queued/run；新建未绑定记录共享 `CQU_BINDING_REQUIRED`，unknown 为 `CQU_BINDING_STATUS_UNKNOWN`，setup.status=created、dispatch_status=sent、run_id=NULL，避免假“排队中”。后续绑定 active 只对无有效数据且错误码为这两类或 `PERSONAL_SYNC_REQUIRED` 的记录启动 initial。普通失败不被每次 GET 自动重试。
- [ ] 修改 dispatch SQL：查询和状态更新只针对 canonical；setup.subscription_ids 仍是三个 view IDs。保留已有 60 秒 dispatch lease，与 sync execution lease 无关。`GET /` 设置 `Cache-Control: private, no-store`；无权限时不创建，已有 personal 只停用不删除。
- [ ] 测试 ordinary GET 无 setup=1 也产生三个真实可解析视图；同一用户 GET 与 POST/defaults 并发最多一次 logical dispatch。保留 `QUEUE_UNAVAILABLE` 后跨请求恢复且 token 不变。
- [ ] 运行三个测试文件、typecheck，提交 `feat(schedule): provision built-in personal views from entitlement`。

### Task 4: 一次个人同步请求、一个 CD、一条消息

**Files:**
- Create: `src/services/personal-subscription-sync.ts`, `src/services/personal-subscription-sync.test.ts`
- Modify: `src/services/sync-status.ts`, `src/routes/v2/subscriptions.ts`
- Test: `src/services/sync-status.test.ts`, `src/routes/v2/subscriptions.test.ts`

**Interfaces:**

```ts
export type SyncClaim =
  | { kind: 'accepted'; runId: string; requestedAt: string }
  | { kind: 'active'; runId: string; requestedAt: string }
  | { kind: 'cooldown'; manualRefreshAt: string };
export function claimSubscriptionRun(
  db: D1Database, subscriptionId: string,
  trigger: SyncTrigger, now: string,
): Promise<SyncClaim>;
export function requestPersonalSync(
  env: Env, userId: string, caps: CalendarCaps,
  bindingStatus: CquBindStatus | undefined,
): Promise<{ status: 'queued'; run_id: string;
  affected_subscription_ids: string[]; cooldown_until: string }>;
```

`claimSubscriptionRun` 定义在 `src/services/sync-status.ts`，`requestPersonalSync` 定义在 `src/services/personal-subscription-sync.ts`；其他生产者从 sync-status 引入 claim。服务内部沿用 `EntitlementError`/现有标准错误转换；`requestPersonalSync` 只接受会话身份，查询唯一 canonical，不接受客户端 userId。claim 不入队，返回 accepted 的调用者负责唯一 send。

- [ ] 加 `POST /personal/syncs` 测试，固定路由必须放在动态 sid 路由之前。

```ts
const app = buildApp('userA');
const list = await (await app.request('/')).json();
app.send.mockClear();
// Fixture 将 initial 标为成功、清空 manual_refresh_at，避免与首次任务混淆。
await env.DB.prepare(`UPDATE subscriptions SET sync_status='success',
  sync_run_id='old', last_synced_at=?, manual_refresh_at=NULL WHERE user_id=?`)
  .bind(new Date().toISOString(), 'userA').run();
const response = await app.request('/personal/syncs', jsonBody({userId:'userB'}));
expect(response.status).toBe(202);
const result = await response.json();
expect(app.send).toHaveBeenCalledTimes(1);
expect(result.affected_subscription_ids.sort()).toEqual(list.subscriptions.map(s=>s.id).sort());
expect(app.send.mock.calls[0][0].userId).toBe('userA');
expect((await readPersonalRows(env.DB, 'userA'))[0].sync_run_id).toBe(result.run_id);
```

- [ ] 运行服务/路由测试，确认新路由缺失且旧三行 CD 逻辑不符合测试。
- [ ] 同一 SQL 条件更新完成 manual_refresh_at、queued、runId 和 reset sync 字段；只允许 cooldown 已过且没有 2 小时内 active run 的 canonical 被接受。claim 失败重读当前状态返回 active 或 cooldown，不再次 send。去掉 refreshTargets 查询、稳定 owner 排序、三行 timestamp 写入和 queueSyncRuns 的个人批量调用。

```sql
UPDATE subscriptions SET manual_refresh_at=?, sync_run_id=?, sync_trigger='manual',
 sync_status='queued', sync_requested_at=?, sync_started_at=NULL,
 sync_finished_at=NULL, sync_error_code=NULL, sync_error_message=NULL, updated_at=?
WHERE id=? AND source_type='personal'
 AND (manual_refresh_at IS NULL OR manual_refresh_at<=?)
 AND (sync_status NOT IN ('queued','running') OR sync_requested_at IS NULL
      OR sync_requested_at<=?);
```

边界时间由同一个 `now` 计算，分别减 5 分钟和 2 小时。Cron/admin 的 claim 不修改 manual_refresh_at，其 UPDATE 也不能替换有效 active run。daily KV counter 仅 accepted+send 成功后增加一次；active/CD 返回不增加。权限、binding 和 quota 校验在接受任务之前完成。

- [ ] accepted 后仅发送 `{subscriptionId: canonical.id,userId,runId,trigger:'manual'}`。发送失败按 id+runId 标 error、按相同 run 和本次 manual_refresh_at 释放 CD。保持原 Retry-After 和 MANUAL_REFRESH_COOLDOWN envelope。CD 已过但原任务活跃时返回同 run 的 202，cooldown_until 为已有 manual_refresh_at+5min；没有历史手动 CD 时用 now，绝不凭空延长 CD。
- [ ] 旧 `/:sid/syncs` 解析个人视图后调用同服务；外部沿旧路径，保持冻结和权益处理。个人 POST 创建及 DELETE 拒绝统一 `PERSONAL_SUBSCRIPTION_MANAGED`，并覆盖内部 personal/三种旧类型；owner 错误先返回404。未知 PATCH/PUT 不新增实现，测试无状态变更。
- [ ] 测试一张卡片入口后其他入口5分钟内均429；并发两个请求一条 send；manual 与 cron claim 不能替换 active；cap revoked、daily disabled、binding unknown 均不入队。运行测试并提交 `feat(schedule): sync the canonical personal subscription once`。

### Task 5: Cron、消费者和管理员只同步一个 personal

**Files:**
- Modify: `src/cron/schedule-sync.ts`, `src/services/sync.ts`, `src/services/sync-status.ts`, `src/services/personal-subscription-sync.ts`, `src/routes/admin.ts`
- Test: `src/cron/schedule-sync.test.ts`, `src/cron/schedule-sync.harvest.test.ts`, `src/cron/schedule-sync.external-guard.test.ts`, `src/services/sync.test.ts`, `src/routes/admin.test.ts`

**Interfaces:**
- New personal messages always use `{subscriptionId: canonical.id,userId,runId,trigger}`; extend `ScheduleSyncMessage.trigger` to include `admin` to match existing `SyncTrigger`.
- `applySyncResult(db,subId,result,ctx,fallback,syncRunId): Promise<boolean>` returns whether guarded write affected exactly one row. Personal callers must always pass runId.
- `buildPersonalSyncResult('personal',data,ics)` builds the same complete data as legacy `personal_all`.
- Producers use Task 4 `claimSubscriptionRun`; consumer calls `executePersonalSync(env, sub, runId, deadlineAt)` from `personal-subscription-sync.ts`. This function accepts a full schema `Subscription`, rejects sourceType other than personal, and returns `Promise<{committed:boolean;data:PersonalScheduleData}>`. It alone composes `fetchPersonalHarvest` → complete snapshot → single-row `applySyncResult`.
- `markSyncRunning(db,subscriptionId,runId): Promise<boolean>` requires queued in the conditional UPDATE. `expireInterruptedRun(db,subscriptionId,runId,startedBefore): Promise<boolean>` only expires a running row older than the cutoff. Both functions live in sync-status.ts; no new lease fields.

- [ ] 写端到端单记录测试：三个视图、一条 canonical；cron 一次只一条消息、harvest mock 一次、canonical 成功，所有视图 API 同步到同一个 run。

```ts
it('harvests and commits one canonical row for all three views', async () => {
  const { id } = await seedPersonal(env.DB, 'user-1');
  const runId = 'single-personal-run';
  await env.DB.prepare(`UPDATE subscriptions SET sync_status='queued',
    sync_run_id=?,sync_requested_at=? WHERE id=?`)
    .bind(runId, new Date().toISOString(), id).run();
  const harvest = vi.spyOn(harvestModule, 'fetchPersonalHarvest')
    .mockResolvedValue({ctx: CTX, data: DATA});
  const {batch, messages} = makeBatch([
    {subscriptionId:id,userId:'user-1',runId,trigger:'manual'},
  ]);
  await processScheduleSyncBatch(batch, testEnv());
  expect(harvest).toHaveBeenCalledTimes(1);
  expect(await readPersonalRows(env.DB, 'user-1')).toHaveLength(1);
  expect(messages[0].ack).toHaveBeenCalledOnce();
});
```

在现有 `schedule-sync.harvest.test.ts` 使用 `makeBatch`、`testEnv`，定义 `CTX={sessionId:'term-1',semesterInfo:{id:'term-1',name:'测试学期',begin_date:'2026-09-01',end_date:'2027-01-31'}}`；`DATA={courses:COURSES,exams:EXAMS,semesterStart:'2026-09-01'}`，课程/考试 fixture 见 Task 6。`SemesterInfo` 包含 id/name/begin_date/end_date，按上面的完整值构造，不能用 any 掩盖。

- [ ] 运行三个 cron 测试和 admin 测试，确认旧 sourceType/fan-out/no-run 消息路径失败。
- [ ] Cron 只扫描真实 canonical，保留 external 的权限对账及 hard-skip。使用 claim 结果为 accepted 的条目建立 due 队列；不遍历 views、不 group 后生成三个 run。initial dispatch 与 Cron 扫描之间由 canonical active run 防止重复入队。
- [ ] 消费者以 subscriptionId 查 canonical，并验证 message.userId 等于实际 row.userId。旧 view 消息先解析，但若 runId 不等于当前共享 run 则 ack；迁移后无 runId 的旧个人消息 ack。删除 `personalSubs` 查询、`syncTargetIds` fan-out、`target.syncRunId === runId ? runId : undefined` 写回。个人执行服务内部的调用链为：

```ts
const {ctx, data} = await fetchPersonalHarvest(env, sub.userId, {deadlineAt});
const ics = preGenerateIcs(data, sub.sourceId);
const committed = await applySyncResult(
  db, sub.id, buildPersonalSyncResult('personal', data, ics),
  ctx, {sessionName:sub.sessionName}, runId,
);
return {committed, data};
```

Queue 成功分支只调用这个个人服务，再在 committed=true 时执行现有 processPersonalNotification。保留 notification try/catch，使邮件处理失败不逆转同步成功。写回 SQL 必须 `WHERE id=? AND sync_run_id=? AND sync_status='running'`，数据与 success 同一个 UPDATE；没有匹配结果就不处理通知。consumer 的查询改为读取完整 Subscription，服务再次检查 sourceType=personal。外部类型在 dispatch 分支就 hard-skip，不能先调用个人服务试错。不新增通用 provider 注册表或外部实现。

- [ ] 数据库原子启动抓取：markSyncRunning 的 WHERE 增加 sync_status=queued，返回changes=1者才进入 executePersonalSync。same-run queued→running 同时请求只能一个true。看到同run running的重复消息不抓取、不改起始时间，`message.retry({delaySeconds:60})`；看到success/error则ack。

```ts
const starts = await Promise.all([
  markSyncRunning(db, id, runId),
  markSyncRunning(db, id, runId),
]);
expect(starts.filter(Boolean)).toHaveLength(1);
```

- [ ] 增加中断恢复：重复投递发现 running 的 sync_started_at 超过14分钟，调用 expireInterruptedRun 条件改 error/SYNC_INTERRUPTED、消息“同步任务已中断，请重试”，保留原数据。SQL同时匹配id/runId/running和截止时间；变化0行就重读，不能错误覆盖已完成结果。14分钟来自当前13分钟总deadline加1分钟收尾余量，是超时检查，不是新租约系统。markSyncRetrying 和成功apply必须要求同run running，防止超时终态被迟到结果逆转。markSyncError仅允许queued/running转error；producer发送失败仍可从queued记录错误。
- [ ] 补充消费者测试：同batch两条相同run消息以及两次并行processScheduleSyncBatch共享同一个D1时，harvest正常只调用一次；运行中重复会retry，成功后重投ack；模拟started_at超过14分钟时保留数据并报中断，接下来新run能正常同步；旧run迟到写入0行。真实D1做状态断言，不能只断言mock锁被调用。
- [ ] 错误/重试只更新 canonical；保持原 capacity 起始时间预算。当前队列至少一次语义和既有 batch/capacity 配置不变，不新增分布式 execution lease。
- [ ] 管理员 `/refresh-all` enabled 模式只选择 personal，并通过 `claimSubscriptionRun(...,'admin',now)` 获得 runId；保留错峰与部分入队失败计数。不为冻结的外部类型 enqueue，不在个人接口中提供外部同步。个人接口永远只查 `source_type=personal AND user_id=当前用户` 的单行。未来外部能力恢复另行实现各自接口。
- [ ] 覆盖失败保留旧 JSON/ICS、stale run 写回0行、终态duplicate、empty exams、用户 UID 区分、权限撤销、外部不会被写入个人数据。运行目标测试和 typecheck，提交 `refactor(schedule): process personal sync as one subscription`。

### Task 6: 旧链接和所有格式保持视图隔离

**Files:**
- Create: `src/services/personal-calendar-projection.ts`, `src/services/personal-calendar-projection.test.ts`
- Modify: `src/routes/v2/calendar.ts`, `src/routes/v2/subscriptions.ts`
- Test: `src/routes/v2/calendar.test.ts`, `src/routes/v2/subscriptions.test.ts`

**Interfaces:**

```ts
export function projectPersonalCalendar(
  sub: Subscription, view: PersonalViewType,
): {icsContent:string;coursesJson:string|null;examsJson:string|null};
```

使用现有 cqu-api 类型、ICS 生成器与 exporter。解析失败仍按现有 `DATA_CORRUPTED` 错误响应，不能静默转换成空课表。尚无数据允许原 EMPTY_ICS；合法的 `[]` 是成功的空集合。

Fixture 使用以下完整业务数据：

```ts
const COURSES = [{name:'测试课程',lecturer:'教师',room:'A101',position:'',
  day_of_week:1,start_session:1,end_session:2,weeks:[1]}];
const EXAMS = [{name:'测试考试',room:'B201',seat:1,
  start_time:'2026-12-20T01:00:00.000Z',end_time:'2026-12-20T03:00:00.000Z'}];
```

- [ ] 五个 public path 参数化测试。all token 包含两个名称，courses 只包含课程，exams 只包含考试；在每种 token 后加 `?view=personal_all` 也不能扩大范围。已有 calendar test 的 uniqueIp helper 用于避开测试 rate limiter，不能全局禁用鉴权或限流。

```ts
for (const path of ['calendar.ics','origin.json','data.json','data.csv','view.json']) {
  const response = await app.request(`/${coursesToken}/${path}?view=personal_all`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('测试课程');
  expect(body).not.toContain('测试考试');
}
```

`app` 使用已有 calendar `buildApp()`；`coursesToken` 由 `insertLink(canonicalId,LINK_FORMATS,{personalViewType:'personal_courses'})` 创建，canonical 写入上述两个数组和 semester_start。

- [ ] 运行 projection、calendar、subscriptions 测试确认旧联表直出会暴露不应出现的数据。
- [ ] `resolveLink` 读出 sourceType、sourceId、stored view type。personal 必须存在有效的 stored view type；缺失/非法个人 scope 拒绝，不能默认 all。legacy 未转换行用其 source_type 推断，external 保持原直出。个人先投影后进入五格式现有处理器：

```ts
const courses = sub.coursesJson ? JSON.parse(sub.coursesJson) : [];
const exams = sub.examsJson ? JSON.parse(sub.examsJson) : [];
const selectedCourses = view === 'personal_exams' ? [] : courses;
const selectedExams = view === 'personal_courses' ? [] : exams;
```

校验数组后用相应 ICS generator。all 合并，courses 排除考试，exams 排除课程。保留 stable sourceId UID、格式 gate、inactive gate、缓存头及 public URL；不缓存共享 canonical 的未区分视图响应。

- [ ] 所有嵌套 link 路由均用 `(canonicalId,viewType)` 筛选。创建 share link 从路径继承 scope，body 不能覆盖；跨同一用户不同视图 lid 也404；PATCH 只允许原 label/formats，不能修改 owner/scope。默认链接修改/删除403，轮换保留 scope。外部使用 NULL scope。
- [ ] migration 模式阻止个人 link 创建、修改、删除、轮换，避免备份和转移时并发写入；公开读取继续。enabled 后普通 share 管理恢复。
- [ ] 运行目标测试与 typecheck，提交 `fix(schedule): preserve calendar link view scope after merging`。

### Task 7: 手动一次性补齐存量，不做按登录迁移

**Files:**
- Create: `src/services/personal-subscription-migration.ts`, `src/services/personal-subscription-migration.test.ts`, `docs/operations/personal-subscription-migration.md`
- Modify: `src/routes/admin.ts`, `src/config/personal-subscription-mode.ts`, `src/routes/v2/subscriptions.ts`, `src/cron/schedule-sync.ts`
- Test: `src/routes/admin.test.ts`

**Interfaces:**

```ts
export type MigrationSummary = {
  users:number; legacyRows:number; createdViews:number;
  preservedLinks:number; createdDefaultLinks:number;
  incompleteSnapshots:number; duplicateDefaults:number;
};
export function migratePersonalUser(
  env: Env, userId: string, apply: boolean,
): Promise<MigrationSummary>;
export function runPersonalMigration(
  env: Env, input:{mode:'dry_run'|'apply'|'verify';after_user_id:string|null;limit:number},
): Promise<{summary:MigrationSummary;next_cursor:string|null;complete:boolean}>;
```

POST `/api/v2/admin/personal-subscription-migration` 使用现有 `ADMIN_SECRET` middleware；没有或错误 secret 返回401，无普通会话替代路径。默认 mode=dry_run，limit=10、最大10；未知 mode、非字符串 cursor、越界 limit 返回400。apply 必须 `PERSONAL_SUBSCRIPTION_MODE=migration`，否则409。verify 对整个数据库检查，不因分页提前报告完成。已有 schema 的个人资源由服务自身唯一性兜底，不额外建设迁移队列。

- [ ] 建真实 D1 fixture 覆盖每一种非空旧类型集合，共7种。迁移后每个用户一条实体、三个视图；所有旧 view ID 存在；旧 token 的 ID/值/formats/scope 均不变；缺视图有新 default。迁移期间没有 Queue send。

```ts
const cases: {types: PersonalViewType[]}[] = [
 {types:['personal_all']}, {types:['personal_courses']}, {types:['personal_exams']},
 {types:['personal_all','personal_courses']}, {types:['personal_all','personal_exams']},
 {types:['personal_courses','personal_exams']},
 {types:['personal_all','personal_courses','personal_exams']},
];
it.each(cases)('fills all built-in views for $types', async ({types}) => {
  // 使用 seedLegacySet(env.DB,'legacy-user',types)；helper 在此文件定义。
  const before = await seedLegacySet(env.DB, 'legacy-user', types);
  await migratePersonalUser(migrationEnv, 'legacy-user', true);
  expect(await readPersonalRows(env.DB, 'legacy-user')).toHaveLength(1);
  const views = await env.DB.prepare(`SELECT id,source_type FROM personal_subscription_views
    WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id=?)`)
    .bind('legacy-user').all();
  expect(views.results).toHaveLength(3);
  for (const id of before.ids) expect(views.results.some(v=>v.id===id)).toBe(true);
  const tokens = await env.DB.prepare('SELECT token FROM calendar_links').all();
  for (const token of before.tokens) expect(tokens.results.some(l=>l.token===token)).toBe(true);
});
```

`seedLegacySet(db,userId,types)` 插入原 source_types，每行按 Task6 fixture 写对应 JSON、last_synced_at、semester_start，用原 id 作为展示 ID；每行一个 default 和一个非默认分享链接，并返回 `{ids:string[],tokens:string[]}`。fixture 值使用本地合成数据。cases 显式声明 PersonalViewType 数组，按对象读取参数。

- [ ] 运行 migration/admin 测试确认缺服务/路由失败。
- [ ] dry_run 只读，列出 user_id 字典序的旧类型 owner，先计算 summary，不写备份、setup、token 或数据。apply 每用户重读旧行及 links/setup，再构建 D1 batch。具体步骤：

  1. canonical 优先 all，否则按 created_at、id 升序选；把旧三组行、所有相关 links、原 setup JSON 完整备份，`user_id` 主键 INSERT 不能覆盖既有备份。
  2. 有 `last_synced_at` 且 JSON 合法者代表有效历史快照，即使当前 sync_status=error 也不能丢。按 freshness 降序选数据学期；学期匹配用非空 semester_start 优先，其次非空 session_name/session_id。完全缺元数据时禁止跨行拼接，只使用最新一行能证明的分量。
  3. 同学期分别选最新课程/考试分量。all 在有效 snapshot 中的 null exams 意味无考试，不能回填更老考试；courses 行的 null exams 则代表没有这个分量。数组空值有效，损坏 JSON 标记 conflict 并中止该用户，保留原行，不猜测。
  4. 创建旧 ID 对应 views，缺类型补 UUID/固定名称。新 links 使用 generateUniqueToken + linkTokenExists 现有 helper；默认已有多个则按 created_at/id 保留一个默认，其他 token 保留为非默认并报告。
  5. 先 UPDATE 每条旧 link 的 subscription_id 与 personal_view_type，再 DELETE 非 survivor 旧实体；不可倒序。UPDATE survivor 的 source_type=personal，source_id=userId，状态和数据按选定完整快照设置；manual_refresh_at 取三行最大。
  6. 更新 setup.subscription_ids 为三个 view IDs，旧 run/dispatch lease 作废。完整数据设 success、last_synced_at 为参与分量最早 freshness；不完整设 error/PERSONAL_SYNC_REQUIRED、last_synced_at=NULL，并保留已有分量。未知学期、较老副本都仍存在 migration backup。此步骤不调用 harvest/send。

- [ ] 为 batch 后半段注入唯一约束失败，断言旧 subscriptions、links、setup、backup 全部回滚；重复 apply 同一用户返回0变更，不能轮换 token。并发两个管理员处理同一用户时，备份唯一键的失败者重读确认已完整转换后跳过，否则报告错误，不吞其他异常。
- [ ] verify 检查 legacy 实体=0、每个 personal 三个 view且每个scope一个default、views/link无孤儿、每个原 token 完整保留、每个 user至多一条personal。global verify 不输出备份JSON或token。分页循环必须以 stable after_user_id 前进；一个用户失败停止并返回可重跑游标，不能静默跳过再报 complete。
- [ ] `migration` 模式暂停 personal manual/defaults/initial/Cron/admin-refresh 与个人 link 写入，返回标准 `503 PERSONAL_SUBSCRIPTION_MIGRATING`；旧 public tokens 和 GET 已有列表仍可读。已转换实体始终按新模型读，不走 legacy fan-out。迁移模式下旧消费消息 ack 并记迁移暂停；转换会清旧 run，enabled 后由 due/initial 恢复。进入模式前未结束的旧版本请求须在操作单中等待确认退出。
- [ ] 操作单写清分阶段步骤：先备份并部署 additive schema+兼容代码（legacy），设置 migration 并确认无旧 writer，dry_run，逐批apply，global verify，切enabled，再做有授权的真实账户验收。最终将 wrangler.jsonc 的模式写为 enabled 并纳入已授权的发布提交，确认下一次 Git Connector 发布不会因仓库默认 legacy 而退回旧模式。操作示例只展示无凭据 body：

```json
{"mode":"dry_run","limit":10,"after_user_id":null}
```

```json
{"mode":"apply","limit":10,"after_user_id":null}
```

下一批用响应的 next_cursor，最后 `{"mode":"verify","limit":10,"after_user_id":null}`。secret 从现有安全环境传入，不能写在文档/curl历史/日志里。线上执行前记录 backup/export 或 Time Travel 恢复点及版本；保持兼容版本回滚，不直接回到旧 schema 代码。
- [ ] 运行 migration、admin、routes、cron 定向测试，提交 `feat(schedule): migrate legacy personal subscriptions in one operator run`。

### Task 8: 前端仅发一个个人请求，保持三卡片展示

**Files:**
- Modify: `frontend/src/api/index.ts`, `frontend/src/views/Dashboard.vue`
- Test: `frontend/src/api/__tests__/index.test.ts`, `frontend/src/views/__tests__/Dashboard.test.ts`
- Explicitly unchanged: `frontend/src/types/api.ts`, `frontend/src/stores/subscriptions.ts`, `frontend/src/views/Add.vue`、所有 CSS/组件布局

**Interfaces:**

```ts
async refreshPersonalSubscription(): Promise<SyncQueuedResponse> {
  const response = await client.post<SyncQueuedResponse>('/subscriptions/personal/syncs', null)
  return response.data
}
```

保留 `refreshSubscription(sid)` 供外部/旧API使用。该方法无 userId/sid 参数，服务器使用当前会话，不在客户端从三个视图选一个代表。

- [ ] 先新增 API 单次POST测试，再改 Dashboard 已有“同步个人课表”测试的 mock：顶层 mockApi 加 `refreshPersonalSubscription`，返回一个 run_id + 三个 affected IDs；断言只调它一次，`refreshSubscription` 未调用。

```ts
const button = wrapper.findAll('button').find(b=>b.text().includes('同步个人课表'));
await button!.trigger('click');
await flushPromises();
expect(mockApi.refreshPersonalSubscription).toHaveBeenCalledTimes(1);
expect(mockApi.refreshPersonalSubscription).toHaveBeenCalledWith();
expect(mockApi.refreshSubscription).not.toHaveBeenCalled();
```

复用已有 mountDashboard fixture，传三个 personal mockSubscription，各自旧source_type和独立ID；不要伪造三个真实后端任务。追加个人卡片刷新也调用同方法一次，外部卡片仍调用原 `refreshSubscription(externalId)`。

- [ ] 将当前测试 `shows delete menu item for personal subscriptions` 反转为不存在删除菜单；三个卡片标题、Badge、复制、二维码、预览、分享仍在。保留已有 external 删除测试。
- [ ] 运行 `npm --prefix frontend test -- src/api/__tests__/index.test.ts src/views/__tests__/Dashboard.test.ts`，确认新请求和删除可见性断言失败。
- [ ] `handleSyncAll` 去掉选 target 代码，改为一次 `api.refreshPersonalSubscription()`；后面的 affected IDs、CD、trackRefresh和reload都保留。`handleRefreshSub` 从store找到sid，personal调用新方法，external调用旧方法：

```ts
const sub = subStore.subscriptions.find(item => item.id === sid)
if (!sub) return
const result = sub.is_personal
  ? await api.refreshPersonalSubscription()
  : await api.refreshSubscription(sid)
```

不要把 API 调用移进 affectedIds 循环。首次失败重试本来调用 handleSyncAll，继续复用。

- [ ] 个人删除菜单加 `v-if="!item.sub.is_personal"`；`openDeleteSubDialog` 遇到 is_personal return；`handleDeleteSub` 再用 store 校验目标必须是 external，避免过期 dialog 状态触发 personal DELETE。共用的 external AlertDialog 保留，不删除整个 Dashboard/路由。
- [ ] 运行两组前端测试、`npm --prefix frontend run build`。核对 git diff frontend/ 只有这四个文件和批准的逻辑区域。提交 `fix(schedule): request personal sync once and hide built-in deletion`。

### Task 9: 完整验收与交接，不自动上线

**Files:**
- Create: `docs/operations/personal-subscription-acceptance.md`
- Review: 本计划、规格、迁移操作单、全部变更和现有 `AGENTS.md`

**Interfaces:** 不新增应用接口。验收分别记录本地/D1迁移/HTTP/Queue/真实账户证据，不把一种通过写成其他层通过。

- [ ] 与执行前记录的基线比较，实现过程中保持 TDD。全部实现完成后执行：

```bash
npm test
npm run typecheck
npm --prefix frontend test
npm --prefix frontend run build
git diff --check
```

- [ ] 在全新本地 D1 应用真实 migrations，七种存量组合使用同一 admin apply 路由演练至 global verify。保存只含计数的报告：每个用户一条 canonical、三view、三default、旧token缺失0、旧实体0、FK违规0、失败写回丢数据0。验证删除/非法修改的请求不改变行数。
- [ ] 用本地 fixture 和 Ego Browser 进行桌面/手机截图对比：卡片布局和文案与基线一致，仅个人删除入口消失。分别点击顶部同步、三种个人卡片同步，Network 每次恰好一条 `POST /subscriptions/personal/syncs`；状态轮询的 GET 不算额外同步。后端记录每个正常接受的run只一条Queue消息、一条canonical写回。浏览器操作按 ego-browser 技能，勿使用用户 Chrome。
- [ ] 查 scope 差异，禁止升级为三实体+共享锁方案。检索旧 fan-out 只允许出现在 legacy 兼容分支和迁移测试，enabled路径必须不存在：

```bash
rg -n 'refreshTargets|cooldownOwner|syncTargetIds|personalSubs|queueSyncRuns' src
rg -n 'refreshPersonalSubscription|refreshSubscription|forEach|Promise.all' frontend/src/views/Dashboard.vue
git diff 6cef19a7781169b7409e46b37723578486e559d0 --stat
```

- [ ] 如果新 tests 因迁移/绑定 fixture而失败，修正合同和fixture，不删除对应验收测试来换绿色。消费失败、状态timeout、旧token保护和external guard必须保留。
- [ ] 总结本地验证结果、迁移模式现值和未执行线上步骤。用户另行授权上线后，按仓库Git Connector流程推送兼容版本、手动迁移、启用，再执行一次授权账户同步与D1/Queue验证。没有授权就交付commit与操作单，不能为了完成本任务自动发送通知邮件或关闭Auth #12。
- [ ] 提交验收报告 `docs(schedule): record personal subscription acceptance`。由执行者按 superpowers 请求代码审查；评审以规格和本清单为准，不能以“请求次数减少”替代“一条真实记录”。

## 规格覆盖自检

| 规格要求 | 计划落实 |
| --- | --- |
| 后端单记录、三展示、独立个人同步接口 | 1、2、4、5、8 |
| 存量一两项一次性手动补齐 | 7、9 |
| 权限自动提供，不依赖setup=1 | 3 |
| 不能增删改个人内置资源 | 4、6、8 |
| 一个run/共享CD/一次日配额 | 4、5 |
| 旧ID/token及五格式数据隔离 | 2、6、7 |
| 单次原子启动、重复投递不重复抓取、失败保留数据和runId保护 | 4、5、7 |
| 首次setup/投递恢复/绑定状态 | 3、5 |
| 管理员刷新和Cron无遗漏 | 5 |
| 前端外观保持，仅删除与同步逻辑小改 | 8、9 |
| 外部订阅不进入个人同步接口 | 4、5、8 |
| 分阶段发布、迁移验收、回滚 | 7、9 |

## 给 5.6-sol high 的启动说明

在上述独立 worktree 阅读规格和本计划。采用 `superpowers:executing-plans` 按顺序执行，或者由用户选择 `subagent-driven-development`。不要重新设计为三条独立订阅，不新增通用并发控制。先核对远端代码变化和工作区，再从 Task 1 开始。实现、局部测试和本地迁移演练可按执行授权完成；生产发布/一次性数据迁移须按用户当时明确授权范围行动。
