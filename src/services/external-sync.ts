import { externalAvailability } from "../config/external-availability";
import { externalAutomaticInterval } from "./external-automatic-scheduling";
import { expireCourseSubscriptions } from "./external-term";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "../types";
import { calendarLinks, subscriptions, type Subscription, type ExternalSourceType } from "../db/schema";
import type { CalendarCaps } from "./auth-rpc";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";
import { buildExternalCaptureResult, ExternalCaptureError } from "./external-capture";
import { markSyncError, markSyncRetrying, expireInterruptedRun, type PublicSyncFailure } from "./sync-status";
import { captureScheduleSyncTerminal } from "../lib/sync-telemetry";

const RETRY_CODES = new Set(["BROWSER_BUSY", "RATE_LIMITED", "SEARCH_TRANSIENT", "CAPTURE_MISSING", "APP_READY_TIMEOUT", "BROWSER_INSTANCE_REPLACED", "WAF_CHALLENGE", "DEADLINE_EXCEEDED", "BROWSER_DEADLINE", "CAPTURE_TRANSIENT", "EXTERNAL_NETWORK_ERROR"]);
function failure(code: string): PublicSyncFailure {
  if (["TGT_EXPIRED", "SESSION_INACTIVE", "CQU_SESSION_INACTIVE", "NEEDS_REAUTH", "NO_CQU_BINDING"].includes(code)) return { code: "NEEDS_REAUTH", message: "学校登录状态已失效，请重新绑定重庆大学统一认证账号" };
  if (["PAGE_PERMISSION_DENIED", "FORBIDDEN"].includes(code)) return { code: "EXTERNAL_TARGET_FORBIDDEN", message: "当前账号无权查看该课表" };
  if (["TARGET_NOT_FOUND", "AMBIGUOUS_TARGET"].includes(code)) return { code, message: "原目标已不可用，请重新选择当前学期目标" };
  if (code === "FEATURE_NOT_ENABLED") return { code, message: "外部订阅权益已撤销" };
  if (code === "EXTERNAL_UNAVAILABLE") return { code, message: "该类外部订阅暂不可用，已保留上次成功结果" };
  if (code === "EXTERNAL_AUTO_DISABLED") return { code, message: "外部自动同步权益已关闭，已保留上次成功结果" };
  if (code === "CAPS_UNAVAILABLE") return { code, message: "暂时无法确认外部订阅权益，请稍后重试" };
  if (["TARGET_MISMATCH", "INVALID_CAPTURE_PAYLOAD", "SCHEMA_INVALID", "UNSUPPORTED_SOURCE_TYPE"].includes(code)) return { code: "EXTERNAL_INVALID_RESPONSE", message: "学校返回的课表无法验证，已保留上次成功结果" };
  return { code: "EXTERNAL_SYNC_UNAVAILABLE", message: "外部课表同步暂时不可用，请稍后重试" };
}
async function currentCaps(env: Env, userId: string): Promise<CalendarCaps | null> {
  try { return (await env.AUTH.getCaps?.({ clientId: env.CALENDAR_CLIENT_ID, clientSecret: env.CALENDAR_CLIENT_SECRET, userId }))?.calendar ?? null; }
  catch { return null; }
}

/** A new external message is never permitted to enter personal harvesting. */
export async function processExternalSyncMessage(env: Env, message: Message<ScheduleSyncMessage>, sub: Subscription, deadlineAt: number, lifecycle?: ExecutionContext): Promise<void> {
  const { runId, sourceVersion, targetRevision } = message.body;
  if (sourceVersion !== 1 || sub.sourceVersion !== 1 || targetRevision !== sub.targetRevision || !runId || sub.syncRunId !== runId || !["active", "reselecting"].includes(sub.externalState) || sub.userId !== message.body.userId) {
    message.ack(); return;
  }
  if (sub.syncStatus === "success" || sub.syncStatus === "error") { message.ack(); return; }
  const db = drizzle(env.DB);
  if (sub.syncStatus === "running") {
    const cutoff = new Date(Date.now() - 14 * 60_000).toISOString();
    if (await expireInterruptedRun(env.DB, sub.id, runId, cutoff)) message.ack();
    else message.retry({ delaySeconds: 60 });
    return;
  }
  const startedAt = Date.now();
  const started = await env.DB.prepare(`UPDATE subscriptions SET sync_status='running',sync_started_at=?,sync_finished_at=NULL,updated_at=?
    WHERE id=? AND user_id=? AND source_version=1 AND target_revision=? AND external_state=?
      AND sync_run_id=? AND sync_status='queued'`)
    .bind(new Date(startedAt).toISOString(), new Date(startedAt).toISOString(), sub.id, sub.userId, sub.targetRevision, sub.externalState, runId).run();
  if (started.meta.changes !== 1) { message.ack(); return; }
  const terminal = { userId: sub.userId, subscriptionId: sub.id, runId, trigger: message.body.trigger ?? "initial" as const,
    requestedAt: sub.syncRequestedAt ? Date.parse(sub.syncRequestedAt) : undefined, executionStartedAt: startedAt, deliveryAttempt: message.attempts ?? 1 };
  async function fail(code: string) {
    const publicError = failure(code);
    if (await markSyncError(db, sub.id, runId!, publicError)) captureScheduleSyncTerminal(env, lifecycle, terminal, "failure", publicError.code);
    message.ack();
  }
  async function reconcile(caps: CalendarCaps | null): Promise<boolean> {
    if (!caps) { await fail("CAPS_UNAVAILABLE"); return false; }
    await env.DB.prepare(`UPDATE calendar_links SET is_active=?,updated_at=? WHERE subscription_id=? AND is_default=0
      AND EXISTS (SELECT 1 FROM subscriptions WHERE id=? AND source_version=1 AND target_revision=?
        AND external_state=? AND sync_run_id=?)`)
      .bind(caps.share && sub.externalState === "active", new Date().toISOString(), sub.id, sub.id,
        sub.targetRevision, sub.externalState, runId).run();
    if (!caps.external) {
      await db.update(subscriptions).set({ isActive: false, updatedAt: new Date().toISOString() })
        .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.userId, sub.userId)));
      await fail("FEATURE_NOT_ENABLED"); return false;
    }
    if (!externalAvailability(env).create_types.includes(sub.sourceType as ExternalSourceType)) { await fail("EXTERNAL_UNAVAILABLE"); return false; }
    if (message.body.trigger === "cron" && externalAutomaticInterval(caps) === null) { await fail("EXTERNAL_AUTO_DISABLED"); return false; }
    return true;
  }
  if (!(await reconcile(await currentCaps(env, sub.userId)))) return;
  let payload: unknown;
  try {
    if (!env.AUTH.cquExternalCapture) { await fail("EXTERNAL_SYNC_UNAVAILABLE"); return; }
    payload = await env.AUTH.cquExternalCapture({ clientId: env.CALENDAR_CLIENT_ID, clientSecret: env.CALENDAR_CLIENT_SECRET,
      userId: sub.userId, sourceType: sub.sourceType as ExternalSourceType, targetId: sub.sourceId, targetName: sub.sourceName,
      ...(sub.sessionId && (sub.sourceType === "course" || message.body.trigger === "initial") ? { expectedSessionId: sub.sessionId } : {}),
      ...(sub.sourceType === "course" ? { courseId: sub.sourceCourseId ?? undefined, courseName: sub.sourceCourseName ?? undefined } : {}), deadlineAt });
  } catch { payload = { error: "EXTERNAL_NETWORK_ERROR" }; }
  if (payload && typeof payload === "object" && "error" in payload) {
    const rawCode = typeof payload.error === "string" ? payload.error : "EXTERNAL_SYNC_UNAVAILABLE";
    if (RETRY_CODES.has(rawCode) && (message.attempts ?? 1) < 3 && Date.now() < deadlineAt) {
      await markSyncRetrying(db, sub.id, runId, { code: "EXTERNAL_RETRYING", message: "学校服务暂时不可用，正在自动重试" });
      message.retry({ delaySeconds: (message.attempts ?? 1) === 1 ? 30 : 120 });
      return;
    }
    await fail(rawCode); return;
  }
  let parsed: ReturnType<typeof buildExternalCaptureResult>;
  try { parsed = buildExternalCaptureResult(payload, { sourceType: sub.sourceType as ExternalSourceType, sourceId: sub.sourceId }); }
  catch (error) { await fail(error instanceof ExternalCaptureError ? error.code : "INVALID_CAPTURE_PAYLOAD"); return; }
  if (sub.sourceType === "course" && parsed.session.id !== sub.sessionId) {
    if (!(await reconcile(await currentCaps(env, sub.userId)))) return;
    await expireCourseSubscriptions(env.DB, sub.userId, parsed.session.id,
      { target: { id: sub.id, revision: sub.targetRevision, runId } });
    message.ack(); return;
  }
  // Re-check authority after a slow browser capture; a mid-flight revocation cannot publish.
  const publishCaps = await currentCaps(env, sub.userId);
  if (!(await reconcile(publishCaps))) return;
  const now = new Date().toISOString();
  const committed = await db.batch([db.update(subscriptions).set({ ...parsed.result,
    externalState: "active", isActive: true,
    sourceName: parsed.sourceName, sessionId: parsed.session.id, sessionName: parsed.session.name,
    lastSyncedAt: now, importQuality: parsed.quality, skippedCount: parsed.skippedCount,
    syncStatus: "success", syncFinishedAt: now, syncErrorCode: null, syncErrorMessage: null, updatedAt: now,
  }).where(and(eq(subscriptions.id, sub.id), eq(subscriptions.userId, sub.userId), eq(subscriptions.sourceVersion, 1),
    eq(subscriptions.sourceId, sub.sourceId), eq(subscriptions.sourceType, sub.sourceType),
    eq(subscriptions.targetRevision, sub.targetRevision), eq(subscriptions.externalState, sub.externalState),
    eq(subscriptions.isActive, sub.externalState === "active"), eq(subscriptions.syncRunId, runId), eq(subscriptions.syncStatus, "running"),
    sub.sessionId === null ? isNull(subscriptions.sessionId) : eq(subscriptions.sessionId, sub.sessionId),
  )),
    // D1 executes this batch atomically. SQLite changes() refers to the preceding
    // guarded subscription write, so a losing/stale run cannot restore any link.
    db.update(calendarLinks).set({
      isActive: sql`CASE WHEN ${calendarLinks.isDefault} = 1 THEN 1 ELSE ${publishCaps!.share ? 1 : 0} END`, updatedAt: now,
    }).where(and(eq(calendarLinks.subscriptionId, sub.id), sql`changes() = 1`)),
  ]);
  if (committed[0].meta.changes === 1) captureScheduleSyncTerminal(env, lifecycle, terminal, "success");
  message.ack();
}
