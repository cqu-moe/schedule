# SessionContext KV 缓存设计

## 问题

用户手动刷新 explore 订阅时，refresh 路由需要 3 个串行 CQU API 调用（getSessionList + getSemesterInfo + fetchTargetSchedule）。CQU 服务器响应不稳定，10-50% 概率超过 Workers 30s 限制返回 502。

## 方案

用 KV 缓存 SessionContext（学期 ID + 学期信息），将 3 次串行调用减少到 1 次。

SessionContext 在一个学期内不变，适合缓存。KV 原生支持 TTL，代码简单，边缘读取快。

## 设计

### KV 缓存

- **Key**: `session:current`
- **Value**: JSON `{ sessionId, semesterInfo }`
- **TTL**: 86400s (24 小时)
- **绑定名**: `CACHE` (KV namespace)

### 代码变更

1. **`wrangler.jsonc`**: 添加 KV namespace 绑定 `CACHE`
2. **`src/types.ts`**: Env 接口添加 `CACHE: KVNamespace`
3. **`src/services/sync.ts`**: 新增 `fetchSessionContextCached(api, kv)` 函数
   - `kv.get("session:current")` → 命中返回
   - 未命中 → 调 `fetchSessionContext(api)` → `kv.put(key, value, { expirationTtl: 86400 })`
4. **`src/routes/subscriptions.ts`**: refresh 路由调用缓存版本
5. **`src/routes/subscriptions.ts`**: 创建订阅路由也调用缓存版本（同样需要 SessionContext）

### 不变的部分

- cron 任务继续用 `fetchSessionContext`（不依赖 KV，cron 本身不受 30s 限制影响）
- 前端无需改动
