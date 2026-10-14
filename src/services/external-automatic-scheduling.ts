import type { CalendarCaps } from "./auth-rpc";

/** Returns the granted automatic interval, or null when automatic syncing is off. */
export function externalAutomaticInterval(caps: CalendarCaps | null): number | null {
  const interval = caps?.external_sync_interval;
  return typeof interval === "number" && Number.isInteger(interval) && interval > 0
    ? interval
    : null;
}

const USER_ACTION_ERRORS = new Set([
  "NEEDS_REAUTH",
  "EXTERNAL_TARGET_FORBIDDEN",
  "TARGET_NOT_FOUND",
  "AMBIGUOUS_TARGET",
]);

/** Terminal school-session/target failures stop automatic churn until reauthorization or reselection. */
export function requiresUserActionAfterSyncFailure(errorCode: string | null): boolean {
  return errorCode !== null && USER_ACTION_ERRORS.has(errorCode);
}

/**
 * Atomically claim one new-version external subscription for a cron run.
 * Concurrent cron invocations can both select the row, but only the CAS winner
 * may replace the run identifier and enqueue it.
 */
export async function claimExternalAutomaticRun(
  database: D1Database,
  subscription: {
    id: string;
    userId: string;
    targetRevision: number;
  },
): Promise<string | null> {
  const now = new Date().toISOString();
  const activeCutoff = new Date(Date.parse(now) - 2 * 60 * 60_000).toISOString();
  const runId = crypto.randomUUID();
  const result = await database.prepare(`UPDATE subscriptions SET
    sync_run_id=?,sync_trigger='cron',sync_status='queued',sync_requested_at=?,
    sync_started_at=NULL,sync_finished_at=NULL,sync_error_code=NULL,
    sync_error_message=NULL,session_recovery_attempts=0,updated_at=?
    WHERE id=? AND user_id=? AND source_version=1 AND target_revision=?
      AND external_state='active' AND is_active=1
      AND (sync_status NOT IN ('queued','running') OR sync_requested_at IS NULL
           OR sync_requested_at<=?)`)
    .bind(
      runId,
      now,
      now,
      subscription.id,
      subscription.userId,
      subscription.targetRevision,
      activeCutoff,
    )
    .run();
  return (result.meta.changes ?? 0) === 1 ? runId : null;
}
