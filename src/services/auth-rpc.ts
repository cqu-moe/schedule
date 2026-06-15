// ── Auth RPC 契约（拓扑①: Service Binding RPC to cqu-moe-auth）──────────────
//
// schedule 不持有任何 CQU 凭据；身份校验与 CQU 会话续命全在 auth 侧。
// 这里只定义 schedule 侧消费 auth WorkerEntrypoint 暴露的 RPC 接口的类型契约。

/** 日历子系统的消费 caps（auth 侧 capabilities 下发，决定配额/特性门禁） */
export interface CalendarCaps {
  sync: boolean;
  external: boolean;
  share: boolean;
  sub_limit: number | null; // null = 无限
  share_limit: number | null;
  sync_interval: number | null; // 分钟；自动同步由每小时 cron 驱动，故 1h 是有效下限，<60 实际等同每小时（非分钟级）
  manual_refresh: number | null; // 次/天
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface VerifiedSession {
  user: SessionUser;
  caps: { calendar: CalendarCaps };
}

export interface GetCquTicketArgs {
  clientId: string;
  /** Per-client OAuth secret; auth hashes + constant-time compares it (RPC is
   *  in-process, so any bound Worker could spoof a clientId without this). */
  clientSecret: string;
  service?: string;
  serviceUrl?: string;
  userId: string;
}

export type GetCquTicketResult = { ticket: string } | { error: string };

/** auth Worker 暴露的 RPC（WorkerEntrypoint）契约 */
export interface AuthService {
  verifySession(cookieHeader: string): Promise<VerifiedSession | null>;
  getCquTicket(args: GetCquTicketArgs): Promise<GetCquTicketResult>;
  getCaps?(userId: string): Promise<{ calendar: CalendarCaps } | null>;
}

/** 缺省/兜底 caps：未授予时的安全保守值（全部拒绝、零配额、最长间隔） */
export const DENY_CAPS: CalendarCaps = {
  sync: false,
  external: false,
  share: false,
  sub_limit: 0,
  share_limit: 0,
  sync_interval: 1440,
  manual_refresh: 0,
};

/**
 * 把配额值解析为可比较的数值：null（明确无限）→ Infinity，正常数字原样返回，
 * 其余（undefined/NaN 等残缺 caps）→ 0（fail closed），绝不因字段缺失而放行。
 */
export function resolveQuota(limit: number | null | undefined): number {
  if (limit === null) return Infinity;
  if (typeof limit !== "number" || Number.isNaN(limit)) return 0;
  return limit;
}
