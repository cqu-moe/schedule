import type { Env } from "../types";
import { captureScheduleEvent } from "./posthog";

type DatabaseSyncTrigger = "cron" | "manual" | "initial" | "admin";
type TelemetrySyncTrigger = "user" | "scheduled" | "automatic";

export interface ScheduleSyncStart {
  userId: string;
  subscriptionId: string;
  runId: string;
  trigger: DatabaseSyncTrigger;
}

export interface ScheduleSyncTerminal extends ScheduleSyncStart {
  requestedAt?: number;
  executionStartedAt?: number;
  deliveryAttempt?: number;
  sessionRecoveryAttempts?: number;
}

function normalizeTrigger(trigger: DatabaseSyncTrigger): TelemetrySyncTrigger {
  if (trigger === "manual") return "user";
  if (trigger === "cron") return "scheduled";
  return "automatic";
}

export function captureScheduleSyncStarted(
  env: Env,
  lifecycle: { waitUntil(promise: Promise<unknown>): void } | undefined,
  start: ScheduleSyncStart,
): void {
  captureScheduleEvent(env, lifecycle, "schedule_sync_started", start.userId, {
    actor_type: "user",
    trigger: normalizeTrigger(start.trigger),
    operation: "sync",
    run_id: start.runId,
    subscription_id: start.subscriptionId,
  });
}

export function captureScheduleSyncTerminal(
  env: Env,
  lifecycle: { waitUntil(promise: Promise<unknown>): void } | undefined,
  terminal: ScheduleSyncTerminal,
  outcome: "success" | "failure",
  errorCode?: string,
): void {
  const now = Date.now();
  const endToEndDurationMs = terminal.requestedAt !== undefined
    && Number.isFinite(terminal.requestedAt)
    && terminal.requestedAt <= now
      ? now - terminal.requestedAt
      : undefined;
  // execution_v2 measures only the latest accepted running attempt. Queue and
  // retry waiting belongs to end_to_end_duration_ms.
  const durationMs = terminal.executionStartedAt === undefined
    ? undefined : Math.max(0, now - terminal.executionStartedAt);
  captureScheduleEvent(env, lifecycle, "schedule_sync_completed", terminal.userId, {
    actor_type: "user",
    outcome,
    trigger: normalizeTrigger(terminal.trigger),
    operation: "sync",
    run_id: terminal.runId,
    subscription_id: terminal.subscriptionId,
    duration_basis: "execution_v2",
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    ...(endToEndDurationMs === undefined ? {} : { end_to_end_duration_ms: endToEndDurationMs }),
    ...(terminal.deliveryAttempt === undefined ? {} : { delivery_attempt: terminal.deliveryAttempt }),
    ...(terminal.sessionRecoveryAttempts === undefined ? {} : {
      session_recovery_attempts: terminal.sessionRecoveryAttempts,
    }),
    ...(errorCode ? { error_code: errorCode } : {}),
  });
}
