# 权限撤销时效 SLO（caps KV + 对账 cron）

issue #87。2026-09-30 选定 B 档：缩短 caps KV TTL 并提高对账 cron 频率，全部在
schedule-cloudflare 仓库内完成，不改 auth 侧。

## 承诺

以下上界适用于 `getCaps` 正常返回明确的 `calendar` 权限对象、cron 和数据库正常
工作的稳态；部署前已写入的 1h TTL 缓存需先自然过期。

- 撤销（auth 侧 cap 失效）到 `subscriptions.is_active` 翻转：最坏 ≤25 分钟
  （caps KV TTL 10 分钟 + cron 每 15 分钟对账一次）。
- 撤销到公开链接停止服务：最坏 ≤30 分钟（再叠加 token 端点 `max-age=300`
  边缘缓存，与既有「已删除/轮换链接 ≤5min 缓存窗口」设计一致）。
- 重新授权（cap 恢复）方向对称，同样 ≤25 分钟。
- 用户手动刷新时使用 `verifySession` 返回的实时 caps 对账撤权，无需等待 cron；
  普通受保护请求只更新 caps KV，并不立即翻转订阅状态。

## 未覆盖的撤权场景

`getCaps` 的 `null` 同时表示用户无任何权益行或客户端认证失败；RPC 异常也在
schedule 侧归为不可确认。此时停止同步，但保留订阅和链接的 `is_active`，避免
认证故障导致所有链接被停用。

因此，清空全部权益（如 auth 管理接口提交 `{ items: [] }`）且用户不再发请求时，
即使 auth 健康也没有有限的公开链接撤销上界。上述 25/30 分钟承诺不覆盖此场景；
RPC 故障期间也不保证该上界。这是尚未解决的跨仓库契约缺口。

后续需由 auth 区分“权威查询确认无权益”和“认证/服务失败”，schedule 才能对前者
执行硬撤销、对后者保留防抖行为。不能直接把所有 `null` 当作已撤权。

## 成本

- 每小时 4 次 cron 扫描；每次对同一用户最多调用一次 `getCaps`。若 caps KV 命中则
  不调用。Queue consumer 的缓存未命中和重试还可能增加 RPC，4 次不是总调用上限。
- 成功同步仍按 `sync_interval`（学生预设 360min）判断到期；提频缩短了到期后等待
  下次 cron 的时间，因此不承诺总入队量完全不变。
- 失败任务以 `syncRequestedAt` 为起点，至少间隔 60min 才能由 cron 新建重试，避免
  `lastSyncedAt` 未更新导致每 15min 重跑。该等待不延迟权限对账，也不影响手动刷新。

## 舍弃的方案

- 只缩 TTL（A 档）：最坏 ~75 分钟，改善不显著。
- auth 撤销时主动推送（C 档，~5 分钟）：需跨仓库改 cqu-moe/auth 并加 service
  binding；课表数据敏感度不足以 justify。将来需要严格 5 分钟 SLO 时另开 issue。
