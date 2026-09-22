import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { resetPersonalData, seedPersonal } from "../../tests/fixtures/personal-subscriptions";
import type { Env } from "../types";
import type { CalendarCaps } from "./auth-rpc";
import {
  ManualRefreshCooldownError,
  requestPersonalSync,
} from "./personal-subscription-sync";
import { claimSubscriptionRun } from "./sync-status";
import * as telemetry from "../lib/posthog";

const CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: true,
  sub_limit: 0,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetPersonalData(env.DB);
});

afterEach(() => vi.restoreAllMocks());

describe("requestPersonalSync", () => {
  it("reports enqueue failure without inventing execution time for a run that never started", async () => {
    const { id } = await seedPersonal(env.DB, "queue-failure-user");
    const capture = vi.spyOn(telemetry, "captureScheduleEvent");
    const testEnv = {
      ...env, PERSONAL_SUBSCRIPTION_MODE: "enabled",
      SCHEDULE_SYNC_QUEUE: { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) },
    } as unknown as Env;

    await expect(requestPersonalSync(testEnv, "queue-failure-user", CAPS, "active"))
      .rejects.toThrow("queue unavailable");

    expect(capture).toHaveBeenCalledOnce();
    const properties = capture.mock.calls[0][4];
    expect(properties).toMatchObject({
      outcome: "failure", duration_basis: "execution_v2", error_code: "QUEUE_UNAVAILABLE",
      end_to_end_duration_ms: expect.any(Number),
    });
    expect(properties).not.toHaveProperty("duration_ms");
    const row = await env.DB.prepare("SELECT sync_status,sync_started_at,manual_refresh_at FROM subscriptions WHERE id=?")
      .bind(id).first();
    expect(row).toEqual({ sync_status: "error", sync_started_at: null, manual_refresh_at: null });
  });

  it("claims one canonical run, sends one message, and returns all view ids", async () => {
    const seeded = await seedPersonal(env.DB, "user-a");
    const send = vi.fn(async () => undefined);
    const testEnv = {
      ...env,
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
      SCHEDULE_SYNC_QUEUE: { send },
    } as unknown as Env;

    const result = await requestPersonalSync(testEnv, "user-a", CAPS, "active");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      subscriptionId: seeded.id,
      userId: "user-a",
      runId: result.run_id,
      trigger: "manual",
    });
    expect(result.affected_subscription_ids.sort()).toEqual(seeded.viewIds.sort());
  });

  it("shares one cooldown and does not send a second message", async () => {
    await seedPersonal(env.DB, "user-a");
    const send = vi.fn(async () => undefined);
    const testEnv = {
      ...env,
      PERSONAL_SUBSCRIPTION_MODE: "enabled",
      SCHEDULE_SYNC_QUEUE: { send },
    } as unknown as Env;

    await requestPersonalSync(testEnv, "user-a", CAPS, "active");
    await expect(requestPersonalSync(testEnv, "user-a", CAPS, "active"))
      .rejects.toBeInstanceOf(ManualRefreshCooldownError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not invent a five-minute cooldown when reusing a non-manual active run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T02:00:00.000Z"));
    try {
      const seeded = await seedPersonal(env.DB, "user-a");
      const active = await claimSubscriptionRun(
        env.DB,
        seeded.id,
        "cron",
        "2026-09-15T02:00:00.000Z",
      );
      if (active.kind !== "accepted") throw new Error("expected cron claim");
      const send = vi.fn(async () => undefined);
      const testEnv = {
        ...env,
        PERSONAL_SUBSCRIPTION_MODE: "enabled",
        SCHEDULE_SYNC_QUEUE: { send },
      } as unknown as Env;

      const result = await requestPersonalSync(testEnv, "user-a", CAPS, "active");
      expect(result.run_id).toBe(active.runId);
      expect(result.cooldown_until).toBe("2026-09-15T02:00:00.000Z");
      expect(send).not.toHaveBeenCalled();
      const row = await env.DB.prepare(`SELECT manual_refresh_at FROM subscriptions WHERE id=?`)
        .bind(seeded.id).first<{ manual_refresh_at: string | null }>();
      expect(row?.manual_refresh_at).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
