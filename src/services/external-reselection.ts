import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { subscriptions } from "../db/schema";
import type { CalendarCaps, CquBindStatus } from "./auth-rpc";
import { assertFlag, EntitlementError } from "../middleware/entitlements";
import { externalAvailability } from "../config/external-availability";
import { resolveExternalSelection } from "./external-target";
import { markSyncError } from "./sync-status";
import { captureScheduleSyncStarted, captureScheduleSyncTerminal } from "../lib/sync-telemetry";

const COOLDOWN_MS = 5 * 60_000;

/** Retarget an expired course in place. Public access resumes only in the consumer's commit. */
export async function reselectExternalCourse(env: Env, userId: string, id: string, caps: CalendarCaps, binding: CquBindStatus | undefined, body: Record<string, unknown>, lifecycle?: ExecutionContext) {
  const db = drizzle(env.DB);
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId))).limit(1);
  if (!sub) throw new EntitlementError("NOT_FOUND", 404, "订阅不存在");
  if (sub.sourceVersion !== 1 || sub.sourceType !== "course" || !["expired", "reselecting"].includes(sub.externalState)) {
    throw new EntitlementError("RESELECTION_UNAVAILABLE", 409, "只有过期的教学班订阅可以重新选择");
  }
  assertFlag(caps, "external", "外部订阅");
  if (binding === undefined) throw new EntitlementError("CQU_BINDING_STATUS_UNKNOWN", 503, "暂时无法确认学校绑定状态");
  if (binding !== "active") throw new EntitlementError("CQU_SESSION_INACTIVE", 409, "请先绑定有效的重庆大学统一认证账号");
  if (!externalAvailability(env, userId).create_types.includes("course") || !env.AUTH.cquExternalCapture) throw new EntitlementError("EXTERNAL_UNAVAILABLE", 503, "教学班订阅暂不可用");
  const selection = await resolveExternalSelection(env, userId, body);
  if (selection.sourceType !== "course" || !selection.course) throw new EntitlementError("INVALID_INPUT", 400, "请选择当前学期教学班");
  if (sub.externalState === "reselecting" && ["queued", "running"].includes(sub.syncStatus)) {
    if (sub.sourceId === selection.target.id && sub.sessionId === selection.session.id && sub.sourceCourseId === selection.course.id) return { status: "queued" as const, run_id: sub.syncRunId, reused: true };
    throw new EntitlementError("SYNC_IN_PROGRESS", 409, "重新同步中，请等待本次同步结束");
  }
  if (sub.reselectionRequestedAt && Date.now() - Date.parse(sub.reselectionRequestedAt) < COOLDOWN_MS) throw new EntitlementError("RESELECTION_COOLDOWN", 429, "请在上次重新选择五分钟后重试");
  const now = new Date().toISOString(), runId = crypto.randomUUID(), revision = sub.targetRevision + 1;
  let accepted: D1Result[];
  try {
    accepted = await env.DB.batch([
      env.DB.prepare(`UPDATE subscriptions SET source_id=?,source_name=?,source_course_id=?,source_course_name=?,session_id=?,session_name=?,
        external_state='reselecting',is_active=0,target_revision=?,reselection_requested_at=?,sync_status='queued',sync_run_id=?,
        sync_trigger='initial',sync_requested_at=?,sync_started_at=NULL,sync_finished_at=NULL,sync_error_code=NULL,sync_error_message=NULL,updated_at=?
        WHERE id=? AND user_id=? AND source_version=1 AND source_type='course' AND target_revision=? AND external_state=?
        AND (external_state='expired' OR sync_status NOT IN ('queued','running'))`)
        .bind(selection.target.id, selection.target.name, selection.course.id, selection.course.name, selection.session.id, selection.session.name,
          revision, now, runId, now, now, id, userId, sub.targetRevision, sub.externalState),
      env.DB.prepare(`UPDATE calendar_links SET is_active=0,updated_at=? WHERE subscription_id=? AND EXISTS
        (SELECT 1 FROM subscriptions WHERE id=? AND sync_run_id=? AND target_revision=? AND external_state='reselecting')`)
        .bind(now, id, id, runId, revision),
    ]);
  } catch (error) {
    if (error instanceof Error && /unique constraint/i.test(error.message)) throw new EntitlementError("ALREADY_EXISTS", 409, "该教学班已有订阅，请选择其他教学班");
    throw error;
  }
  if (accepted[0].meta.changes !== 1) throw new EntitlementError("RESELECTION_CHANGED", 409, "订阅状态已变化，请刷新后重试");
  try {
    await env.SCHEDULE_SYNC_QUEUE.send({ subscriptionId: id, userId, trigger: "initial", runId, sourceVersion: 1, targetRevision: revision });
    captureScheduleSyncStarted(env, lifecycle, { userId, subscriptionId: id, runId, trigger: "initial" });
  } catch {
    if (await markSyncError(db, id, runId, { code: "QUEUE_UNAVAILABLE", message: "同步服务暂时不可用，请重新选择后重试" })) {
      await env.DB.prepare("UPDATE subscriptions SET reselection_requested_at=NULL WHERE id=? AND sync_run_id=? AND target_revision=? AND sync_status='error' AND sync_error_code='QUEUE_UNAVAILABLE'").bind(id, runId, revision).run();
      captureScheduleSyncTerminal(env, lifecycle, { userId, subscriptionId: id, runId, trigger: "initial", requestedAt: Date.parse(now) }, "failure", "QUEUE_UNAVAILABLE");
    }
  }
  return { status: "queued" as const, run_id: runId, reused: false };
}
