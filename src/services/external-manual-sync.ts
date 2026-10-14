import { drizzle } from "drizzle-orm/d1";
import { externalAvailability } from "../config/external-availability";
import type { ExternalSourceType } from "../db/schema";
import { EntitlementError } from "../middleware/entitlements";
import { CHINA_TZ_OFFSET_MS } from "../utils/time";
import type { CalendarCaps, CquBindStatus } from "./auth-rpc";
import { resolveQuota } from "./auth-rpc";
import { markSyncError } from "./sync-status";
import {
  captureScheduleSyncStarted,
  captureScheduleSyncTerminal,
} from "../lib/sync-telemetry";
import type { Env } from "../types";

const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60_000;

export class ExternalManualRefreshCooldownError extends Error {
  constructor(readonly manualRefreshAt: string) {
    super("EXTERNAL_MANUAL_REFRESH_COOLDOWN");
  }
}

export interface ExternalManualSyncResult {
  status: "queued";
  run_id: string;
  affected_subscription_ids: string[];
  cooldown_until: string;
  manual_remaining: number | null;
}

interface ExternalManualSubscription {
  id: string;
  user_id: string;
  source_type: ExternalSourceType;
  source_version: number;
  target_revision: number;
  external_state: "active" | "expired" | "reselecting";
  is_active: number;
  sync_status: "idle" | "queued" | "running" | "success" | "error";
  sync_run_id: string | null;
  sync_requested_at: string | null;
  manual_refresh_at: string | null;
}

export function externalManualQuotaDate(now = new Date()): string {
  return new Date(now.getTime() + CHINA_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

export async function getExternalManualRemaining(
  env: Env,
  userId: string,
  caps: CalendarCaps,
  now = new Date(),
): Promise<number | null> {
  const limit = resolveQuota(caps.external_manual_refresh);
  if (limit === Infinity) return null;
  if (limit === 0) return 0;

  const usage = await env.DB.prepare(
    "SELECT used_count FROM external_manual_refresh_usage WHERE user_id=? AND quota_date=?",
  ).bind(userId, externalManualQuotaDate(now)).first<{ used_count: number }>();
  return Math.max(limit - (usage?.used_count ?? 0), 0);
}

async function readSubscription(
  env: Env,
  userId: string,
  subscriptionId: string,
): Promise<ExternalManualSubscription | null> {
  return env.DB.prepare(`SELECT id,user_id,source_type,source_version,target_revision,external_state,
    is_active,sync_status,sync_run_id,sync_requested_at,manual_refresh_at
    FROM subscriptions WHERE id=? AND user_id=?`)
    .bind(subscriptionId, userId)
    .first<ExternalManualSubscription>();
}

function inFlight(sub: ExternalManualSubscription): boolean {
  return (sub.sync_status === "queued" || sub.sync_status === "running") &&
    Boolean(sub.sync_run_id && sub.sync_requested_at);
}

function cooldownUntil(manualRefreshAt: string | null, now: string): string {
  return new Date(Date.parse(manualRefreshAt ?? now) + MANUAL_REFRESH_COOLDOWN_MS).toISOString();
}

async function reuseResult(
  env: Env,
  userId: string,
  caps: CalendarCaps,
  sub: ExternalManualSubscription,
  now: Date,
): Promise<ExternalManualSyncResult> {
  return {
    status: "queued",
    run_id: sub.sync_run_id!,
    affected_subscription_ids: [sub.id],
    cooldown_until: cooldownUntil(sub.manual_refresh_at, now.toISOString()),
    manual_remaining: await getExternalManualRemaining(env, userId, caps, now),
  };
}

function assertExternalManualAdmission(
  env: Env,
  caps: CalendarCaps,
  binding: CquBindStatus | undefined,
  sub: ExternalManualSubscription,
): void {
  if (
    !externalAvailability(env, sub.user_id).create_types.includes(sub.source_type) ||
    !env.AUTH.cquExternalCapture
  ) {
    throw new EntitlementError("EXTERNAL_UNAVAILABLE", 503, "外部订阅功能暂不可用");
  }
  if (!caps.external) {
    throw new EntitlementError("FEATURE_NOT_ENABLED", 403, "外部订阅未开通");
  }
  if (sub.source_version !== 1 || sub.external_state !== "active" || !sub.is_active) {
    throw new EntitlementError("EXTERNAL_UNAVAILABLE", 503, "外部订阅功能暂不可用");
  }
  if (binding === undefined) {
    throw new EntitlementError("CQU_BINDING_STATUS_UNKNOWN", 503, "暂时无法确认学校绑定状态");
  }
  if (binding !== "active") {
    throw new EntitlementError("CQU_SESSION_INACTIVE", 409, "请先绑定有效的重庆大学统一认证账号");
  }
  const limit = resolveQuota(caps.external_manual_refresh);
  if (limit === 0) {
    throw new EntitlementError("RATE_LIMITED", 429, "外部手动刷新未授予或已关闭");
  }
}

export async function requestExternalManualSync(
  env: Env,
  userId: string,
  caps: CalendarCaps,
  binding: CquBindStatus | undefined,
  subscriptionId: string,
  lifecycle?: ExecutionContext,
): Promise<ExternalManualSyncResult> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const quotaDate = externalManualQuotaDate(nowDate);
  const cooldownCutoff = new Date(nowDate.getTime() - MANUAL_REFRESH_COOLDOWN_MS).toISOString();
  let sub = await readSubscription(env, userId, subscriptionId);
  if (!sub) throw new EntitlementError("NOT_FOUND", 404, "订阅不存在");

  assertExternalManualAdmission(env, caps, binding, sub);
  if (inFlight(sub)) return reuseResult(env, userId, caps, sub, nowDate);
  if (sub.manual_refresh_at && sub.manual_refresh_at > cooldownCutoff) {
    throw new ExternalManualRefreshCooldownError(sub.manual_refresh_at);
  }

  const runId = crypto.randomUUID();
  const limit = resolveQuota(caps.external_manual_refresh);
  let claimed = false;

  {
    // The batch is a D1 transaction. A failed subscription claim refunds this
    // request's reservation before commit, while concurrent requests serialize on
    // the one (user, China-day) usage row and cannot both spend the last unit.
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO external_manual_refresh_usage
        (user_id,quota_date,used_count,last_run_id,created_at,updated_at)
        VALUES (?,?,1,?,?,?)
        ON CONFLICT(user_id,quota_date) DO UPDATE SET
          used_count=external_manual_refresh_usage.used_count+1,
          last_run_id=excluded.last_run_id,
          updated_at=excluded.updated_at
        WHERE ? IS NULL OR external_manual_refresh_usage.used_count < ?
        RETURNING used_count`)
        .bind(userId, quotaDate, runId, now, now, limit === Infinity ? null : limit, limit === Infinity ? null : limit),
      env.DB.prepare(`UPDATE subscriptions SET
        manual_refresh_at=?,sync_run_id=?,sync_trigger='manual',sync_status='queued',
        sync_requested_at=?,sync_started_at=NULL,sync_finished_at=NULL,
        sync_error_code=NULL,sync_error_message=NULL,session_recovery_attempts=0,updated_at=?
        WHERE id=? AND user_id=? AND source_version=1 AND target_revision=?
          AND external_state='active' AND is_active=1
          AND sync_status IN ('idle','success','error')
          AND (manual_refresh_at IS NULL OR manual_refresh_at<=?)
          AND EXISTS (SELECT 1 FROM external_manual_refresh_usage
            WHERE user_id=? AND quota_date=? AND last_run_id=?)`)
        .bind(now, runId, now, now, sub.id, userId, sub.target_revision,
          cooldownCutoff, userId, quotaDate, runId),
      env.DB.prepare(`UPDATE external_manual_refresh_usage SET
        used_count=CASE WHEN used_count>0 THEN used_count-1 ELSE 0 END,updated_at=?
        WHERE user_id=? AND quota_date=? AND last_run_id=?
          AND NOT EXISTS (SELECT 1 FROM subscriptions
            WHERE id=? AND user_id=? AND sync_run_id=? AND sync_status='queued')`)
        .bind(now, userId, quotaDate, runId, sub.id, userId, runId),
      env.DB.prepare(`INSERT INTO external_manual_refresh_reservations (run_id,user_id,quota_date)
        SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM subscriptions
          WHERE id=? AND user_id=? AND sync_run_id=? AND sync_status='queued')
          AND EXISTS (SELECT 1 FROM external_manual_refresh_usage
            WHERE user_id=? AND quota_date=? AND last_run_id=?)`)
        .bind(runId, userId, quotaDate, sub.id, userId, runId, userId, quotaDate, runId),
    ]);
    claimed = (results[1].meta.changes ?? 0) === 1;
  }

  if (!claimed) {
    sub = await readSubscription(env, userId, subscriptionId);
    if (!sub) throw new EntitlementError("NOT_FOUND", 404, "订阅不存在");
    if (inFlight(sub)) return reuseResult(env, userId, caps, sub, nowDate);
    if (sub.manual_refresh_at && sub.manual_refresh_at > cooldownCutoff) {
      throw new ExternalManualRefreshCooldownError(sub.manual_refresh_at);
    }
    const remaining = await getExternalManualRemaining(env, userId, caps, nowDate);
    if (remaining === 0) {
      throw new EntitlementError("RATE_LIMITED", 429, "今日外部手动刷新次数已达上限");
    }
    throw new Error("EXTERNAL_MANUAL_CLAIM_FAILED");
  }

  try {
    await env.SCHEDULE_SYNC_QUEUE.send({
      subscriptionId: sub.id,
      userId,
      trigger: "manual",
      runId,
      sourceVersion: 1,
      targetRevision: sub.target_revision,
    });
    captureScheduleSyncStarted(env, lifecycle, {
      userId,
      subscriptionId: sub.id,
      runId,
      trigger: "manual",
    });
  } catch (error) {
    const won = await markSyncError(drizzle(env.DB), sub.id, runId, {
      code: "QUEUE_UNAVAILABLE",
      message: "同步服务暂时不可用，请稍后重试",
    });
    if (won) {
      captureScheduleSyncTerminal(env, lifecycle, {
        userId,
        subscriptionId: sub.id,
        runId,
        trigger: "manual",
        requestedAt: Date.parse(now),
      }, "failure", "QUEUE_UNAVAILABLE");
    }
    // Consume the enqueue receipt atomically, independently of subscription/run
    // survival and of later reservations against the same daily aggregate.
    await env.DB.batch([
      env.DB.prepare(`UPDATE external_manual_refresh_usage SET
        used_count=CASE WHEN used_count>0 THEN used_count-1 ELSE 0 END,updated_at=?
        WHERE user_id=? AND quota_date=? AND EXISTS (
          SELECT 1 FROM external_manual_refresh_reservations
          WHERE run_id=? AND user_id=? AND quota_date=?)`)
        .bind(new Date().toISOString(), userId, quotaDate, runId, userId, quotaDate),
      env.DB.prepare("DELETE FROM external_manual_refresh_reservations WHERE run_id=? AND user_id=? AND quota_date=?")
        .bind(runId, userId, quotaDate),
      env.DB.prepare(`UPDATE subscriptions SET manual_refresh_at=NULL
        WHERE id=? AND sync_run_id=? AND manual_refresh_at=?
          AND sync_status='error' AND sync_error_code='QUEUE_UNAVAILABLE'`)
        .bind(sub.id, runId, now),
    ]);
    throw error;
  }

  await env.DB.prepare("DELETE FROM external_manual_refresh_reservations WHERE run_id=? AND user_id=? AND quota_date=?")
    .bind(runId, userId, quotaDate).run();

  return {
    status: "queued",
    run_id: runId,
    affected_subscription_ids: [sub.id],
    cooldown_until: new Date(nowDate.getTime() + MANUAL_REFRESH_COOLDOWN_MS).toISOString(),
    manual_remaining: await getExternalManualRemaining(env, userId, caps, nowDate),
  };
}
