# 注册后即时同步设计

## 问题

新用户注册后创建的 3 个 personal 订阅（`personal_all`、`personal_courses`、`personal_exams`）的 `icsContent` 为 NULL。ICS 内容仅在以下时机填充：
- 每日 cron 同步（19:00 CST）
- 用户手动点击刷新

这意味着新注册用户在首次 cron 运行或手动刷新前，订阅链接返回 404。

## 方案

使用 `ctx.waitUntil()` 在注册接口返回后立即在后台执行首次同步。

### 为什么选择 waitUntil 而非 Queue

| 维度 | waitUntil | Queue |
|------|-----------|-------|
| 延迟 | 2-3 秒 | 数秒到数十秒 |
| 复杂度 | 低 | 中（需入队+等待 consumer） |
| 重试 | 无自动重试 | 有自动重试 |
| 失败兜底 | 用户手动刷新 / 等待每日 cron | 自动 |

waitUntil 的低延迟和简单性优于 Queue 的自动重试，因为：
1. 注册时 token 刚获取，几乎不会过期
2. 失败时用户可手动刷新，且每日 cron 也会补上
3. 注册是低频操作，不需要队列的削峰能力

## 后端改动

### `src/routes/users.ts`

注册接口（`POST /api/v1/users`）在返回 `{ calendar_token }` 后，通过 `c.executionCtx.waitUntil()` 触发后台同步：

```typescript
// 返回响应（不等待同步）
const response = c.json({ calendar_token: calendarToken });

// 后台同步
c.executionCtx.waitUntil(
  syncNewUserSubscriptions(c.env, newUser, personalSubs)
);

return response;
```

### 新增函数 `syncNewUserSubscriptions`

在 `src/routes/users.ts` 中新增，复用 `src/services/sync.ts` 中的现有函数：

```typescript
async function syncNewUserSubscriptions(
  env: Env,
  user: { id: string; studentId: string; accessToken: string },
  subs: { id: string; sourceType: string }[],
): Promise<void> {
  const db = drizzle(env.DB);
  const api = new CQUAPIClient(user.accessToken);
  const ctx = await fetchSessionContextCached(api, env.CACHE);
  const personalData = await fetchPersonalSchedule(api, user.studentId, ctx);

  for (const sub of subs) {
    const result = await buildPersonalSyncResult(sub.sourceType, personalData, user.studentId);
    await applySyncResult(db, sub.id, result, ctx, {});
  }

  await db.update(users).set({
    lastRefreshAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(users.id, user.id));
}
```

需要 `returning()` 拿到新创建的订阅 ID 列表。当前 `for` 循环逐条插入 → 改为 `db.insert().values([...]).returning()` 批量插入。

## 前端改动

### `frontend/src/views/Dashboard.vue`

1. **订阅卡片状态**：`last_synced_at === null` 时显示"同步中"（带 spinner），替代当前的"尚未同步"
2. **轮询机制**：注册后首次进入 Dashboard，对未同步订阅轮询：
   - 每 2 秒调用 `getSubscriptions`
   - 当所有订阅的 `last_synced_at` 不为 null 时停止
   - 30 秒超时后停止，保留"尚未同步"状态（用户可手动刷新）
3. **轮询仅在存在未同步订阅时启动**，避免已有用户不必要的轮询

## 数据流

```
用户注册
  → POST /api/v1/users
  → 创建 user + 3 个订阅 (icsContent=null)
  → 返回 { calendar_token }
  → ctx.waitUntil(syncNewUserSubscriptions(...))

前端
  → 保存 token → 跳转 /dashboard
  → 加载订阅列表
  → 发现 last_synced_at=null 的订阅 → 显示"同步中" + 启动轮询
  → 每 2 秒 getSubscriptions
  → 所有 last_synced_at 有值 → 停止轮询，正常显示
  → 30 秒超时 → 停止轮询，显示"尚未同步"

后台 (waitUntil)
  → fetchSessionContextCached()
  → fetchPersonalSchedule()
  → 为每个订阅 buildPersonalSyncResult() + applySyncResult()
  → 更新 user.lastRefreshAt
```

## 错误处理

- **后台同步失败**：`waitUntil` 中的错误会被 Workers runtime 记录到日志，不影响已返回的响应
- **前端超时**：30 秒轮询超时后，订阅显示正常的"尚未同步"状态，用户可手动刷新
- **兜底机制**：每日 19:00 的 cron 同步会补上任何遗漏的同步
