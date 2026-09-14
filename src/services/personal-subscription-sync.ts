import { EntitlementError } from "../middleware/entitlements";
import type { Env } from "../types";
import type { CalendarCaps, CquBindStatus } from "./auth-rpc";
import { resolveQuota } from "./auth-rpc";
import { personalSubscriptionMode } from "../config/personal-subscription-mode";
import { listPersonalViews } from "./personal-subscription-views";
import { prepareDefaultSubscriptions } from "./personal-subscription-setup";
import { dispatchPersonalSetup } from "./personal-setup-dispatch";
import { claimSubscriptionRun, markSyncError } from "./sync-status";
import { drizzle } from "drizzle-orm/d1";
import { CHINA_TZ_OFFSET_MS } from "../utils/time";
import type { Subscription } from "../db/schema";
import { fetchPersonalHarvest } from "./cqu-harvest";
import {
  applySyncResult,
  buildPersonalSyncResult,
  preGenerateIcs,
  type PersonalScheduleData,
} from "./sync";

const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60_000;

export class ManualRefreshCooldownError extends Error {
  constructor(readonly manualRefreshAt: string) {
    super("MANUAL_REFRESH_COOLDOWN");
  }
}

export async function requestPersonalSync(
  env: Env,
  userId: string,
  caps: CalendarCaps,
  bindingStatus: CquBindStatus | undefined,
): Promise<{
  status: "queued";
  run_id: string;
  affected_subscription_ids: string[];
  cooldown_until: string;
}> {
  const mode = personalSubscriptionMode(env);
  if (mode === "migration") {
    throw new EntitlementError(
      "PERSONAL_SUBSCRIPTION_MIGRATING",
      503,
      "个人课表正在维护，请稍后重试",
    );
  }
  if (mode !== "enabled") {
    throw new EntitlementError(
      "PERSONAL_SUBSCRIPTION_NOT_READY",
      409,
      "个人课表尚未完成升级",
    );
  }
  if (!caps.sync) {
    await env.DB.prepare(`UPDATE subscriptions SET is_active=0,updated_at=?
      WHERE user_id=? AND source_type='personal'`)
      .bind(new Date().toISOString(), userId)
      .run();
    throw new EntitlementError("FEATURE_NOT_ENABLED", 403, "日历同步未开通");
  }
  if (bindingStatus === undefined) {
    throw new EntitlementError(
      "CQU_BINDING_STATUS_UNKNOWN",
      503,
      "暂时无法确认统一认证绑定状态",
    );
  }
  if (bindingStatus !== "active") {
    throw new EntitlementError(
      "CQU_BINDING_REQUIRED",
      409,
      "请先绑定重庆大学统一认证账号",
    );
  }

  let canonical = await env.DB.prepare(`SELECT id,manual_refresh_at FROM subscriptions
    WHERE user_id=? AND source_type='personal' LIMIT 1`)
    .bind(userId)
    .first<{ id: string; manual_refresh_at: string | null }>();
  if (!canonical) {
    const prepared = await prepareDefaultSubscriptions(env, userId, caps, bindingStatus);
    if (prepared.status === "created" || prepared.status === "resumed") {
      await dispatchPersonalSetup(env, userId);
    }
    canonical = await env.DB.prepare(`SELECT id,manual_refresh_at FROM subscriptions
      WHERE user_id=? AND source_type='personal' LIMIT 1`)
      .bind(userId)
      .first<{ id: string; manual_refresh_at: string | null }>();
  }
  if (!canonical) throw new Error("PERSONAL_SUBSCRIPTION_NOT_FOUND");

  const limit = resolveQuota(caps.manual_refresh);
  const dayKey = new Date(Date.now() + CHINA_TZ_OFFSET_MS).toISOString().slice(0, 10);
  const counterKey = `refresh:${userId}:${dayKey}`;
  let used = 0;
  if (limit !== Infinity) {
    const raw = await env.CACHE.get(counterKey);
    used = raw ? Number(raw) || 0 : 0;
    if (used >= limit) {
      throw new EntitlementError("RATE_LIMITED", 429, "今日手动刷新次数已达上限");
    }
  }

  const now = new Date().toISOString();
  const claim = await claimSubscriptionRun(env.DB, canonical.id, "manual", now);
  if (claim.kind === "cooldown") {
    throw new ManualRefreshCooldownError(claim.manualRefreshAt);
  }

  if (claim.kind === "accepted") {
    try {
      await env.SCHEDULE_SYNC_QUEUE.send({
        subscriptionId: canonical.id,
        userId,
        runId: claim.runId,
        trigger: "manual",
      });
    } catch (error) {
      await markSyncError(drizzle(env.DB), canonical.id, claim.runId, {
        code: "QUEUE_UNAVAILABLE",
        message: "同步服务暂时不可用，请稍后重试",
      });
      await env.DB.prepare(`UPDATE subscriptions SET manual_refresh_at=NULL
        WHERE id=? AND sync_run_id=? AND manual_refresh_at=?`)
        .bind(canonical.id, claim.runId, now)
        .run();
      throw error;
    }
    if (limit !== Infinity) {
      await env.CACHE.put(counterKey, String(used + 1), {
        expirationTtl: 60 * 60 * 25,
      }).catch(() => {});
    }
  }

  const views = await listPersonalViews(env.DB, canonical.id);
  const cooldownUntil = claim.kind === "accepted"
    ? new Date(Date.parse(claim.requestedAt) + MANUAL_REFRESH_COOLDOWN_MS).toISOString()
    : canonical.manual_refresh_at
      ? new Date(Date.parse(canonical.manual_refresh_at) + MANUAL_REFRESH_COOLDOWN_MS).toISOString()
      : now;
  return {
    status: "queued",
    run_id: claim.runId,
    affected_subscription_ids: views.map((view) => view.id),
    cooldown_until: cooldownUntil,
  };
}

export async function executePersonalSync(
  env: Env,
  subscription: Subscription,
  runId: string,
  deadlineAt: number,
): Promise<{ committed: boolean; data: PersonalScheduleData }> {
  if (subscription.sourceType !== "personal") {
    throw new Error("PERSONAL_SYNC_REQUIRES_CANONICAL_SUBSCRIPTION");
  }
  const { ctx, data } = await fetchPersonalHarvest(env, subscription.userId, { deadlineAt });
  const ics = preGenerateIcs(data, subscription.sourceId);
  const committed = await applySyncResult(
    drizzle(env.DB),
    subscription.id,
    buildPersonalSyncResult("personal", data, ics),
    ctx,
    { sessionName: subscription.sessionName },
    runId,
  );
  return { committed, data };
}
