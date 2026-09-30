# 权限撤销时效 SLO（caps KV + 对账 cron）

issue #87。2026-09-30 选定 B 档：缩短 caps KV TTL 并提高对账 cron 频率，全部在
schedule-cloudflare 仓库内完成，不改 auth 侧。

## 承诺

- 撤销（auth 侧 cap 失效）到 `subscriptions.is_active` 翻转：最坏 ≤25 分钟
  （caps KV TTL 10 分钟 + cron 每 15 分钟对账一次）。
- 撤销到公开链接停止服务：最坏 ≤30 分钟（再叠加 token 端点 `max-age=300`
  边缘缓存，与既有「已删除/轮换链接 ≤5min 缓存窗口」设计一致）。
- 重新授权（cap 恢复）方向对称，同样 ≤25 分钟。
- 例外：auth `getCaps` RPC 瞬时故障时对账 fail-skip（防抖动设计），窗口顺延
  至 RPC 恢复。
- 用户自己发请求时立即生效（`verifySession` 返回实时 caps，手动刷新路由同步
  对账），不受本上界约束。

## 成本

- inactive 用户（10 分钟内无请求）每小时最多 4 次 `getCaps` RPC 回填（原先约
  1 次）；活跃用户无额外 RPC（会话中间件每次请求都刷新 caps KV）。
- cron 每 15 分钟扫一次 subscriptions 表并对账；sync_interval 档位（学生预设
  360min）远高于 cron 周期，due-gating 保证入队量不因提频增加。

## 舍弃的方案

- 只缩 TTL（A 档）：最坏 ~75 分钟，改善不显著。
- auth 撤销时主动推送（C 档，~5 分钟）：需跨仓库改 cqu-moe/auth 并加 service
  binding；课表数据敏感度不足以 justify。将来需要严格 5 分钟 SLO 时另开 issue。
