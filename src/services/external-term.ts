import type { Env } from "../types";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";
import { searchExternal } from "./external-search";

const CHECK_INTERVAL = 6 * 60 * 60_000;
const FAILURE_COOLDOWN = 30 * 60_000;
const LEASE_DURATION = 2 * 60_000;
const EXPIRED_MESSAGE = "教学班所属学期已结束，默认链接与全部分享链接已停用";

/** Used by term reconciliation and target reselection. Tokens and private snapshots are retained. */
export interface CourseTermObservation { id: string; target_revision: number; session_id: string | null }
export interface CourseExpirationGuard {
  leaseToken?: string;
  target?: { id: string; revision: number; runId: string };
  observedTargets?: CourseTermObservation[];
}
export async function expireCourseSubscriptions(database: D1Database, userId: string, currentSessionId: string, guard: CourseExpirationGuard = {}): Promise<void> {
  const { leaseToken, target, observedTargets } = guard;
  if (!currentSessionId.trim()) return;
  const now = new Date().toISOString();
  const fence = leaseToken ? " AND EXISTS (SELECT 1 FROM external_term_checks WHERE user_id=? AND lease_token=? AND lease_until>?)" : "";
  const targetFence = target ? " AND id=? AND target_revision=? AND sync_run_id=?" : "";
  const observedFence = observedTargets ? ` AND EXISTS (SELECT 1 FROM json_each(?) observation
    WHERE json_extract(observation.value,'$.id')=subscriptions.id
      AND json_extract(observation.value,'$.target_revision')=subscriptions.target_revision
      AND json_extract(observation.value,'$.session_id') IS subscriptions.session_id)` : "";
  const values = [now, EXPIRED_MESSAGE, now, userId, currentSessionId, ...(leaseToken ? [userId, leaseToken, Date.now()] : []), ...(target ? [target.id, target.revision, target.runId] : []), ...(observedTargets ? [JSON.stringify(observedTargets)] : [])];
  await database.batch([
    database.prepare(`UPDATE subscriptions SET external_state='expired',is_active=0,target_revision=target_revision+1,
      sync_run_id=NULL,sync_status='error',sync_finished_at=?,sync_error_code='EXTERNAL_TERM_EXPIRED',sync_error_message=?,updated_at=?
      WHERE user_id=? AND source_version=1 AND source_type='course' AND external_state IN ('active','reselecting')
        AND session_id IS NOT NULL AND session_id<>?${fence}${targetFence}${observedFence}`).bind(...values),
    database.prepare(`UPDATE calendar_links SET is_active=0,updated_at=? WHERE subscription_id IN
      (SELECT id FROM subscriptions WHERE user_id=? AND source_version=1 AND source_type='course' AND external_state='expired')`).bind(now, userId),
  ]);
}

/** Cron only leases and enqueues bounded work; no school/browser RPC runs here. */
export async function checkExternalTerms(env: Env): Promise<void> {
  const now = Date.now();
  const users = await env.DB.prepare(`SELECT s.user_id,MIN(s.id) AS anchor,COALESCE(t.next_check_at,0) AS due_at
    FROM subscriptions s LEFT JOIN external_term_checks t ON t.user_id=s.user_id
    WHERE s.source_version=1 AND s.source_type='course' AND s.external_state IN ('active','reselecting')
      AND COALESCE(t.next_check_at,0)<=? AND COALESCE(t.lease_until,0)<=?
    GROUP BY s.user_id ORDER BY due_at,s.user_id LIMIT 32`).bind(now, now).all<{ user_id: string; anchor: string }>();
  const messages: { body: ScheduleSyncMessage }[] = [];
  for (const { user_id: userId, anchor } of users.results) {
    const token = crypto.randomUUID();
    const claim = await env.DB.prepare(`INSERT INTO external_term_checks (user_id,next_check_at,lease_token,lease_until,status)
      VALUES (?,?,?,?,'queued') ON CONFLICT(user_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,
      next_check_at=excluded.next_check_at,status='queued'
      WHERE external_term_checks.next_check_at<=? AND external_term_checks.lease_until<=?`)
      .bind(userId, now + FAILURE_COOLDOWN, token, now + FAILURE_COOLDOWN, now, now).run();
    if (claim.meta.changes === 1) messages.push({ body: { purpose: "external_term_check", subscriptionId: anchor, userId, runId: token, trigger: "cron" } });
  }
  if (!messages.length) return;
  try { await env.SCHEDULE_SYNC_QUEUE.sendBatch(messages); }
  catch {
    await env.DB.batch(messages.map(({ body }) => env.DB.prepare(`UPDATE external_term_checks
      SET lease_token=NULL,lease_until=0,status='idle',next_check_at=? WHERE user_id=? AND lease_token=? AND status='queued'`)
      .bind(Date.now() + 5 * 60_000, body.userId, body.runId)));
  }
}

/** Runs in the Queue consumer's per-user lane before the subscription guard. */
export async function processExternalTermCheck(env: Env, message: Message<ScheduleSyncMessage>, batchDeadline: number): Promise<void> {
  const { userId, runId: token } = message.body;
  if (!token) { message.ack(); return; }
  const now = Date.now(), deadlineAt = Math.min(batchDeadline, now + 95_000);
  const claim = await env.DB.prepare(`UPDATE external_term_checks SET status='running',lease_until=?
    WHERE user_id=? AND lease_token=? AND status='queued' AND lease_until>?`)
    .bind(now + LEASE_DURATION, userId, token, now).run();
  if (claim.meta.changes !== 1) { message.ack(); return; }
  let sessionId: string | null = null;
  try {
    const observed = await env.DB.prepare(`SELECT id,target_revision,session_id FROM subscriptions
      WHERE user_id=? AND source_version=1 AND source_type='course' AND external_state IN ('active','reselecting')`)
      .bind(userId).all<CourseTermObservation>();
    const args = { clientId: env.CALENDAR_CLIENT_ID, clientSecret: env.CALENDAR_CLIENT_SECRET, userId };
    const caps = observed.results.length ? await env.AUTH.getCaps?.(args) : null;
    if (caps?.calendar.external === true && env.AUTH.cquExternalSearch && Date.now() < deadlineAt) {
      const result = await searchExternal(env, userId, { sourceType: "department", deadlineAt });
      if (!(result instanceof Response) && Date.now() < deadlineAt) {
        const currentCaps = await env.AUTH.getCaps?.(args);
        if (currentCaps?.calendar.external === true && Date.now() < deadlineAt) {
          sessionId = result.session.id;
          await expireCourseSubscriptions(env.DB, userId, sessionId, { leaseToken: token, observedTargets: observed.results });
        }
      }
    }
  } catch { sessionId = null; }
  const finished = Date.now();
  await env.DB.prepare(`UPDATE external_term_checks SET checked_at=COALESCE(?,checked_at),session_id=COALESCE(?,session_id),
    next_check_at=?,lease_token=NULL,lease_until=0,status='idle' WHERE user_id=? AND lease_token=?`)
    .bind(sessionId ? new Date(finished).toISOString() : null, sessionId,
      finished + (sessionId ? CHECK_INTERVAL : FAILURE_COOLDOWN), userId, token).run();
  message.ack();
}
