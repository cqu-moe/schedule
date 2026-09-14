import { and, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { subscriptions, type SyncTrigger } from "../db/schema";
import { HarvestError } from "./cqu-harvest";

type Db = ReturnType<typeof drizzle>;

export interface PublicSyncFailure {
  code: string;
  message: string;
}

export type SyncClaim =
  | { kind: "accepted"; runId: string; requestedAt: string }
  | { kind: "active"; runId: string; requestedAt: string }
  | { kind: "cooldown"; manualRefreshAt: string };

export async function claimSubscriptionRun(
  database: D1Database,
  subscriptionId: string,
  trigger: SyncTrigger,
  now: string,
): Promise<SyncClaim> {
  const nowMs = Date.parse(now);
  const activeCutoff = new Date(nowMs - 2 * 60 * 60_000).toISOString();
  const cooldownCutoff = new Date(nowMs - 5 * 60_000).toISOString();
  const runId = crypto.randomUUID();
  const manual = trigger === "manual";
  const result = await database.prepare(`UPDATE subscriptions SET
    manual_refresh_at=CASE WHEN ?='manual' THEN ? ELSE manual_refresh_at END,
    sync_run_id=?,sync_trigger=?,sync_status='queued',sync_requested_at=?,
    sync_started_at=NULL,sync_finished_at=NULL,sync_error_code=NULL,
    sync_error_message=NULL,updated_at=?
    WHERE id=? AND source_type='personal'
      AND (? != 'manual' OR manual_refresh_at IS NULL OR manual_refresh_at<=?)
      AND (sync_status NOT IN ('queued','running') OR sync_requested_at IS NULL
           OR sync_requested_at<=?)`)
    .bind(
      trigger,
      now,
      runId,
      trigger,
      now,
      now,
      subscriptionId,
      trigger,
      cooldownCutoff,
      activeCutoff,
    )
    .run();
  if ((result.meta.changes ?? 0) === 1) {
    return { kind: "accepted", runId, requestedAt: now };
  }

  const current = await database.prepare(`SELECT sync_status,sync_run_id,sync_requested_at,
    manual_refresh_at FROM subscriptions WHERE id=? AND source_type='personal'`)
    .bind(subscriptionId)
    .first<{
      sync_status: string;
      sync_run_id: string | null;
      sync_requested_at: string | null;
      manual_refresh_at: string | null;
    }>();
  if (!current) throw new Error("PERSONAL_SUBSCRIPTION_NOT_FOUND");
  if (manual && current.manual_refresh_at && current.manual_refresh_at > cooldownCutoff) {
    return { kind: "cooldown", manualRefreshAt: current.manual_refresh_at };
  }
  if (
    (current.sync_status === "queued" || current.sync_status === "running")
    && current.sync_run_id
    && current.sync_requested_at
    && current.sync_requested_at > activeCutoff
  ) {
    return {
      kind: "active",
      runId: current.sync_run_id,
      requestedAt: current.sync_requested_at,
    };
  }
  throw new Error("PERSONAL_SYNC_CLAIM_FAILED");
}

export async function queueSyncRun(
  db: Db,
  subscriptionId: string,
  trigger: SyncTrigger,
  runId = crypto.randomUUID(),
): Promise<string> {
  return queueSyncRuns(db, [subscriptionId], trigger, runId);
}

/** Queue one logical sync run for one or more subscription rows. */
export async function queueSyncRuns(
  db: Db,
  subscriptionIds: string[],
  trigger: SyncTrigger,
  runId = crypto.randomUUID(),
): Promise<string> {
  if (subscriptionIds.length === 0) return runId;
  const now = new Date().toISOString();
  await db.update(subscriptions).set({
    syncStatus: "queued",
    syncRunId: runId,
    syncTrigger: trigger,
    syncRequestedAt: now,
    syncStartedAt: null,
    syncFinishedAt: null,
    syncErrorCode: null,
    syncErrorMessage: null,
    updatedAt: now,
  }).where(inArray(subscriptions.id, subscriptionIds));
  return runId;
}

export async function markSyncRunning(db: Db, subscriptionId: string, runId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.update(subscriptions).set({
    syncStatus: "running",
    syncStartedAt: now,
    syncFinishedAt: null,
    syncErrorCode: null,
    syncErrorMessage: null,
    updatedAt: now,
  }).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.syncRunId, runId)));
  return (result.meta?.changes ?? 0) > 0;
}

export async function markSyncError(
  db: Db,
  subscriptionId: string,
  runId: string,
  failure: PublicSyncFailure,
): Promise<void> {
  const now = new Date().toISOString();
  await db.update(subscriptions).set({
    syncStatus: "error",
    syncFinishedAt: now,
    syncErrorCode: failure.code,
    syncErrorMessage: failure.message,
    updatedAt: now,
  }).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.syncRunId, runId)));
}

export async function markSyncSuccess(db: Db, subscriptionId: string, runId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.update(subscriptions).set({
    syncStatus: "success",
    syncFinishedAt: now,
    syncErrorCode: null,
    syncErrorMessage: null,
    updatedAt: now,
  }).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.syncRunId, runId)));
}

export async function markSyncRetrying(
  db: Db,
  subscriptionId: string,
  runId: string,
  failure: PublicSyncFailure,
): Promise<void> {
  const now = new Date().toISOString();
  await db.update(subscriptions).set({
    syncStatus: "queued",
    syncFinishedAt: null,
    syncErrorCode: failure.code,
    syncErrorMessage: failure.message,
    updatedAt: now,
  }).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.syncRunId, runId)));
}

export function isRetryableSyncFailure(error: unknown): boolean {
  if (!(error instanceof HarvestError)) return true;
  return !/NEEDS_REAUTH|SESSION_INACTIVE|FEATURE_NOT_ENABLED|INVALID_HARVEST_URL/i.test(error.message);
}

/**
 * User-facing text while a sync run WAITS for browser capacity. Only ever
 * written via markSyncRetrying inside the bounded capacity branch — once the
 * wait ends (success, or terminal failure via {@link publicSyncFailure}) the
 * row no longer shows "排队中".
 */
export const CAPACITY_WAIT_MESSAGE = "同步任务排队中，稍后自动重试";

/** Public failure shown during the bounded capacity wait (stable code preserved). */
export function capacityWaitFailure(error: unknown): PublicSyncFailure {
  return { code: publicSyncFailure(error).code, message: CAPACITY_WAIT_MESSAGE };
}

export function publicSyncFailure(error: unknown): PublicSyncFailure {
  if (error instanceof HarvestError) {
    if (/NEEDS_REAUTH|SESSION_INACTIVE/i.test(error.message)) {
      return { code: "NEEDS_REAUTH", message: "登录状态已失效，请到账号设置重新绑定" };
    }
    const stableCode = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "HARVEST_FAILED";
    if (stableCode === "BROWSER_DEADLINE" || stableCode === "BROWSER_INSTANCE_REPLACED") {
      // Controlled transient infrastructure failure — the message must never
      // read like a password/account problem to the user.
      return { code: stableCode, message: "同步服务暂时繁忙，请稍后重试" };
    }
    return {
      code: stableCode,
      message: "学校系统暂时无法完成同步，请稍后重试",
    };
  }
  return { code: "INTERNAL_ERROR", message: "同步服务暂时不可用，请稍后重试" };
}
