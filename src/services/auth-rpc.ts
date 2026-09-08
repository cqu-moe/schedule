// ── Auth RPC 契约（拓扑①: Service Binding RPC to cqu-moe-auth）──────────────
//
// schedule 不持有任何 CQU 凭据；身份校验与 CQU 会话续命全在 auth 侧。
// 这里只定义 schedule 侧消费 auth WorkerEntrypoint 暴露的 RPC 接口的类型契约。

/** 日历子系统的消费 caps（auth 侧 capabilities 下发，决定配额/特性门禁） */
export interface CalendarCaps {
  sync: boolean;
  external: boolean;
  share: boolean;
  change_notification: boolean;
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

// ── cquHarvest (拓扑①: organic harvest 取数原语) ──────────────────────────────
//
// my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP 取课表(POST)被 412 专守;唯一过墙路径
// 是让 auth 在用户已登录的浏览器会话里有机 fire 请求、截获响应。cquHarvest 是
// 业务无关的批量取数原语:auth 起一个临时浏览器、注入该用户保活的 storageState、
// 导航 navUrl(过瑞数,页面自动 fire 课表/学期)、按 `capture` 模式截获响应、再对
// `fetch` 列表逐个做 in-page GET(同源、读豁免),一次 RPC 返回 {captures, fetches}。
// host 白名单(仅 my.cqu.edu.cn)/ 限流 / needs_reauth 熔断全在 auth 侧。

/** One in-page GET to run inside the already-past-瑞数 browser context. */
export interface HarvestFetchSpec {
  /** Only GET is supported (read 豁免); POST writes are 412 专守, never harvest via fetch. */
  method: "GET";
  /** Absolute URL on my.cqu.edu.cn (auth host-whitelists it). */
  url: string;
}

export interface CquHarvestArgs {
  clientId: string;
  /** Per-client OAuth secret; auth constant-time compares it (same gate as getCquTicket). */
  clientSecret: string;
  /** The auth user whose保活 CQU session is hydrated into the harvest browser. */
  userId: string;
  /** URL to navigate (过瑞数; the page organically fires 课表/学期 requests). */
  navUrl: string;
  /**
   * Response-URL substrings to capture: the harvest browser records the body of
   * every response whose URL contains one of these (e.g. "my-table-detail").
   */
  capture: string[];
  /** In-page GETs to run in the same已过瑞数 context after navigation settles. */
  fetch: HarvestFetchSpec[];
  /**
   * Optional absolute deadline (ms epoch) shared by every phase of one logical
   * harvest. Auth clamps it to now+13min; omitting it lets auth apply its own cap.
   */
  deadlineAt?: number;
}

/** One captured/fetched response body. `body` is the raw text (caller JSON.parses). */
export interface HarvestEntry {
  url: string;
  status: number;
  contentType?: string;
  body: string;
}

export type CquHarvestResult =
  | { captures: HarvestEntry[]; fetches: HarvestEntry[] }
  | { error: string };

/** Args for getCaps — authenticated like getCquTicket (RPC caller self-reports
 *  clientId, so auth verifies clientSecret; getCaps enumerates by arbitrary userId). */
export interface GetCapsArgs {
  clientId: string;
  clientSecret: string;
  userId: string;
}

/** auth Worker 暴露的 RPC（WorkerEntrypoint）契约 */
export interface AuthService {
  verifySession(cookieHeader: string): Promise<VerifiedSession | null>;
  getCquTicket(args: GetCquTicketArgs): Promise<GetCquTicketResult>;
  getCaps?(args: GetCapsArgs): Promise<{ calendar: CalendarCaps } | null>;
  /** Organic-harvest 取数原语 (拓扑①). Optional so older auth deploys typecheck;
   *  callers must null-guard (`env.AUTH.cquHarvest?.(...)`). */
  cquHarvest?(args: CquHarvestArgs): Promise<CquHarvestResult>;
}

/** 缺省/兜底 caps：未授予时的安全保守值（全部拒绝、零配额、最长间隔） */
export const DENY_CAPS: CalendarCaps = {
  sync: false,
  external: false,
  share: false,
  change_notification: false,
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
