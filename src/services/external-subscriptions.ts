import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { calendarLinks, subscriptions, LINK_FORMATS, type ExternalSourceType } from "../db/schema";
import type { CalendarCaps, CquBindStatus } from "./auth-rpc";
import { resolveQuota } from "./auth-rpc";
import { assertFlag, EntitlementError } from "../middleware/entitlements";
import { externalAvailability } from "../config/external-availability";
import { resolveExternalSelection } from "./external-target";
import { captureScheduleSyncStarted, captureScheduleSyncTerminal } from "../lib/sync-telemetry";
import { markSyncError } from "./sync-status";

export async function createExternalSubscription(env: Env, userId: string, caps: CalendarCaps, binding: CquBindStatus | undefined, body: Record<string, unknown>, lifecycle?: ExecutionContext) {
  if (!externalAvailability(env).create_types.includes(body.sourceType as ExternalSourceType) || !env.AUTH.cquExternalCapture) {
    throw new EntitlementError("EXTERNAL_UNAVAILABLE", 503, "外部订阅功能暂不可用");
  }
  assertFlag(caps, "external", "外部订阅");
  if (binding === undefined) throw new EntitlementError("CQU_BINDING_STATUS_UNKNOWN", 503, "暂时无法确认学校绑定状态");
  if (binding !== "active") throw new EntitlementError("CQU_SESSION_INACTIVE", 409, "请先绑定有效的重庆大学统一认证账号");
  const selection = await resolveExternalSelection(env, userId, body);
  const db = drizzle(env.DB);
  const [duplicate] = await db.select({ id: subscriptions.id }).from(subscriptions).where(and(
    eq(subscriptions.userId, userId), eq(subscriptions.sourceVersion, 1),
    eq(subscriptions.sourceType, selection.sourceType), eq(subscriptions.sourceId, selection.target.id),
  )).limit(1);
  if (duplicate) throw new EntitlementError("ALREADY_EXISTS", 409, "该订阅已存在");
  const limit = resolveQuota(caps.sub_limit);
  const id = crypto.randomUUID(), runId = crypto.randomUUID(), linkId = crypto.randomUUID(), token = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  let admitted = false;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO subscriptions
        (id,user_id,source_type,source_id,source_name,session_id,session_name,source_version,is_personal,is_active,
         sync_status,sync_run_id,sync_trigger,sync_requested_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,1,0,1,'queued',?,'initial',?,?,?
        WHERE (SELECT count(*) FROM subscriptions WHERE user_id=? AND source_version=1) < ?`)
        .bind(id, userId, selection.sourceType, selection.target.id, selection.target.name, selection.session.id, selection.session.name,
          runId, now, now, now, userId, Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER),
      env.DB.prepare(`INSERT INTO calendar_links
        (id,subscription_id,token,formats,is_default,is_active,created_at,updated_at)
        SELECT ?,id,?,?,1,1,?,? FROM subscriptions WHERE id=?`)
        .bind(linkId, token, JSON.stringify(LINK_FORMATS), now, now, id),
    ]);
    admitted = results[0].meta.changes === 1;
  } catch (error) {
    if (error instanceof Error && /unique constraint/i.test(error.message)) throw new EntitlementError("ALREADY_EXISTS", 409, "该订阅已存在");
    throw error;
  }
  if (!admitted) throw new EntitlementError("QUOTA_EXCEEDED", 409, "外部订阅数量已达上限");
  try {
    await env.SCHEDULE_SYNC_QUEUE.send({ subscriptionId: id, userId, trigger: "initial", runId, sourceVersion: 1, targetRevision: 0 });
    captureScheduleSyncStarted(env, lifecycle, { userId, subscriptionId: id, runId, trigger: "initial" });
  } catch {
    if (await markSyncError(db, id, runId, { code: "QUEUE_UNAVAILABLE", message: "同步服务暂时不可用，请稍后重试" })) {
      captureScheduleSyncTerminal(env, lifecycle, { userId, subscriptionId: id, runId, trigger: "initial", requestedAt: Date.parse(now) }, "failure", "QUEUE_UNAVAILABLE");
    }
  }
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  const [link] = await db.select().from(calendarLinks).where(eq(calendarLinks.id, linkId));
  return { subscription, link };
}
