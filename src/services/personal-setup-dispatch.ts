import type { Env } from "../types";
import type { ScheduleSyncMessage } from "../cron/schedule-sync";
import { getPersonalSetup } from "./personal-subscription-setup";
import { personalSubscriptionMode } from "../config/personal-subscription-mode";
import {
  captureScheduleSyncStarted,
  captureScheduleSyncTerminal,
} from "../lib/sync-telemetry";

const DISPATCH_LEASE_MS = 60_000;

interface DispatchTarget {
  id: string;
}

async function finishOwnedLease(env: Env, userId: string, leaseToken: string): Promise<void> {
  await env.DB.prepare(`UPDATE personal_subscription_setup
    SET dispatch_status='sent', lease_token=NULL, lease_until=0, updated_at=?
    WHERE user_id=? AND lease_token=?`)
    .bind(new Date().toISOString(), userId, leaseToken)
    .run();
}

export async function dispatchPersonalSetup(
  env: Env,
  userId: string,
  lifecycle?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const mode = personalSubscriptionMode(env);
  if (mode === "migration") return;
  const nowMs = Date.now();
  const leaseToken = crypto.randomUUID();
  const now = new Date(nowMs).toISOString();
  const claim = await env.DB.prepare(`UPDATE personal_subscription_setup
    SET dispatch_status='sending', lease_token=?, lease_until=?, updated_at=?
    WHERE user_id=? AND status='created' AND dispatch_status!='sent' AND lease_until<=?`)
    .bind(leaseToken, nowMs + DISPATCH_LEASE_MS, now, userId, nowMs)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) return;

  const row = await getPersonalSetup(env.DB, userId);
  if (!row || row.status !== "created" || !row.run_id) {
    const failureNow = Date.now();
    await env.DB.prepare(`UPDATE personal_subscription_setup
      SET dispatch_status='failed', lease_until=?, updated_at=?
      WHERE user_id=? AND lease_token=?`)
      .bind(failureNow + DISPATCH_LEASE_MS, new Date(failureNow).toISOString(), userId, leaseToken)
      .run();
    throw new Error("PERSONAL_SETUP_RUN_ID_MISSING");
  }
  const runId = row.run_id;

  const target = await env.DB.prepare(`SELECT id FROM subscriptions
    WHERE user_id=? AND sync_run_id=?
      AND ${mode === "enabled"
        ? "source_type='personal'"
        : "source_type IN ('personal_all','personal_courses','personal_exams')"}
    ORDER BY CASE source_type
      WHEN 'personal_all' THEN 0
      WHEN 'personal_courses' THEN 1
      ELSE 2 END, id
    LIMIT 1`)
    .bind(userId, runId)
    .first<DispatchTarget>();
  if (!target) {
    await finishOwnedLease(env, userId, leaseToken);
    return;
  }

  const dispatchTime = new Date().toISOString();
  const affectedTargets = await env.DB.prepare(`SELECT id FROM subscriptions
    WHERE ${mode === "enabled"
      ? "id=? AND sync_run_id=? AND source_type='personal'"
      : "user_id=? AND sync_run_id=? AND source_type IN ('personal_all','personal_courses','personal_exams')"}
    `)
    .bind(mode === "enabled" ? target.id : userId, runId)
    .all<{ id: string }>();
  await env.DB.prepare(`UPDATE subscriptions SET
    sync_status=CASE WHEN sync_error_code='QUEUE_UNAVAILABLE' THEN 'queued' ELSE sync_status END,
    sync_requested_at=CASE
      WHEN sync_started_at IS NULL AND sync_trigger='initial'
        AND (sync_status='queued' OR sync_error_code='QUEUE_UNAVAILABLE')
      THEN ? ELSE sync_requested_at END,
    sync_finished_at=CASE WHEN sync_error_code='QUEUE_UNAVAILABLE' THEN NULL ELSE sync_finished_at END,
    sync_error_code=CASE WHEN sync_error_code='QUEUE_UNAVAILABLE' THEN NULL ELSE sync_error_code END,
    sync_error_message=CASE WHEN sync_error_code='QUEUE_UNAVAILABLE' THEN NULL ELSE sync_error_message END,
    updated_at=?
    WHERE ${mode === "enabled"
      ? "id=? AND sync_run_id=? AND source_type='personal'"
      : "user_id=? AND sync_run_id=? AND source_type IN ('personal_all','personal_courses','personal_exams')"}`)
    .bind(dispatchTime, dispatchTime, mode === "enabled" ? target.id : userId, runId)
    .run();

  try {
    await env.SCHEDULE_SYNC_QUEUE.send({
      userId,
      subscriptionId: target.id,
      runId,
      trigger: "initial",
    } satisfies ScheduleSyncMessage);
    captureScheduleSyncStarted(env, lifecycle, {
      userId,
      subscriptionId: target.id,
      runId,
      trigger: "initial",
    });
  } catch (error) {
    const failureNowMs = Date.now();
    const failureNow = new Date(failureNowMs).toISOString();
    const failed = await env.DB.prepare(`UPDATE personal_subscription_setup
      SET dispatch_status='failed', lease_until=?, updated_at=?
      WHERE user_id=? AND lease_token=?`)
      .bind(failureNowMs + DISPATCH_LEASE_MS, failureNow, userId, leaseToken)
      .run();
    if ((failed.meta.changes ?? 0) === 1) {
      await env.DB.prepare(`UPDATE subscriptions SET sync_status='error',
        sync_finished_at=?, sync_error_code='QUEUE_UNAVAILABLE',
        sync_error_message='同步服务暂时不可用，请稍后重试', updated_at=?
        WHERE ${mode === "enabled"
          ? "id=? AND sync_run_id=? AND source_type='personal'"
          : "user_id=? AND sync_run_id=? AND source_type IN ('personal_all','personal_courses','personal_exams')"}`)
        .bind(failureNow, failureNow, mode === "enabled" ? target.id : userId, runId)
        .run();
      for (const affected of affectedTargets.results) {
        captureScheduleSyncTerminal(env, lifecycle, {
          userId,
          subscriptionId: affected.id,
          runId,
          trigger: "initial",
          requestedAt: Date.parse(dispatchTime),
        }, "failure", "QUEUE_UNAVAILABLE");
      }
    }
    throw error;
  }

  await finishOwnedLease(env, userId, leaseToken);
}

export async function dispatchPendingPersonalSetups(
  env: Env,
  lifecycle?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const pending = await env.DB.prepare(`SELECT user_id FROM personal_subscription_setup
    WHERE status='created' AND dispatch_status!='sent' AND lease_until<=?
    ORDER BY updated_at, user_id LIMIT 25`)
    .bind(Date.now())
    .all<{ user_id: string }>();

  for (const row of pending.results) {
    try {
      await dispatchPersonalSetup(env, row.user_id, lifecycle);
    } catch (error) {
      console.error(JSON.stringify({
        event: "personal_setup.dispatch_recovery_failed",
        userId: row.user_id,
        error: error instanceof Error ? error.message : String(error),
        message: "Failed to recover initial personal setup dispatch",
      }));
    }
  }
}
