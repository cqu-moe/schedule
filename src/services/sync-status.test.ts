import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { HarvestError } from "./cqu-harvest";
import {
  CAPACITY_WAIT_MESSAGE,
  capacityWaitFailure,
  isRetryableSyncFailure,
  publicSyncFailure,
  claimSubscriptionRun,
  markSyncRunning,
  expireInterruptedRun,
  claimSessionRecoveryAttempt,
  markSyncError,
  markSyncSuccess,
} from "./sync-status";
import { drizzle } from "drizzle-orm/d1";
import { resetPersonalData, seedPersonal } from "../../tests/fixtures/personal-subscriptions";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetPersonalData(env.DB);
});

describe("claimSubscriptionRun", () => {
  it("allows only one concurrent canonical claim", async () => {
    const { id } = await seedPersonal(env.DB, "claim-user");
    const now = new Date().toISOString();
    const claims = await Promise.all([
      claimSubscriptionRun(env.DB, id, "cron", now),
      claimSubscriptionRun(env.DB, id, "cron", now),
    ]);
    expect(claims.filter((claim) => claim.kind === "accepted")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "active")).toHaveLength(1);
    expect(new Set(claims.map((claim) => "runId" in claim ? claim.runId : null)).size).toBe(1);
  });

  it("allows only one queued-to-running transition", async () => {
    const { id } = await seedPersonal(env.DB, "start-user");
    const claim = await claimSubscriptionRun(env.DB, id, "cron", new Date().toISOString());
    if (claim.kind !== "accepted") throw new Error("expected accepted claim");
    const starts = await Promise.all([
      markSyncRunning(drizzle(env.DB), id, claim.runId),
      markSyncRunning(drizzle(env.DB), id, claim.runId),
    ]);
    expect(starts.filter(Boolean)).toHaveLength(1);
  });

  it("expires only an old running instance and preserves its data", async () => {
    const { id } = await seedPersonal(env.DB, "interrupted-user");
    const claim = await claimSubscriptionRun(env.DB, id, "cron", new Date().toISOString());
    if (claim.kind !== "accepted") throw new Error("expected accepted claim");
    await markSyncRunning(drizzle(env.DB), id, claim.runId);
    const old = new Date(Date.now() - 15 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE subscriptions SET sync_started_at=?,courses_json='[]' WHERE id=?`)
      .bind(old, id)
      .run();

    expect(await expireInterruptedRun(
      env.DB,
      id,
      claim.runId,
      new Date(Date.now() - 14 * 60_000).toISOString(),
    )).toBe(true);
    const row = await env.DB.prepare(`SELECT sync_status,sync_error_code,courses_json
      FROM subscriptions WHERE id=?`).bind(id).first<{
        sync_status: string;
        sync_error_code: string;
        courses_json: string;
      }>();
    expect(row).toEqual({
      sync_status: "error",
      sync_error_code: "SYNC_INTERRUPTED",
      courses_json: "[]",
    });
  });

  it("lets only the first success transition win", async () => {
    const { id } = await seedPersonal(env.DB, "success-terminal-user");
    const claim = await claimSubscriptionRun(env.DB, id, "cron", new Date().toISOString());
    if (claim.kind !== "accepted") throw new Error("expected accepted claim");
    await markSyncRunning(drizzle(env.DB), id, claim.runId);

    expect(await markSyncSuccess(drizzle(env.DB), id, claim.runId)).toBe(true);
    expect(await markSyncSuccess(drizzle(env.DB), id, claim.runId)).toBe(false);
  });

  it("lets only the first failure transition win", async () => {
    const { id } = await seedPersonal(env.DB, "failure-terminal-user");
    const claim = await claimSubscriptionRun(env.DB, id, "manual", new Date().toISOString());
    if (claim.kind !== "accepted") throw new Error("expected accepted claim");
    const failure = { code: "SAFE_TEST_FAILURE", message: "safe failure" };

    expect(await markSyncError(drizzle(env.DB), id, claim.runId, failure)).toBe(true);
    expect(await markSyncError(drizzle(env.DB), id, claim.runId, failure)).toBe(false);
  });
});

describe("claimSessionRecoveryAttempt", () => {
  it("increments only the owned running generation and resets on a new run", async () => {
    const { id } = await seedPersonal(env.DB, "recovery-counter-user");
    const first = await claimSubscriptionRun(env.DB, id, "manual", new Date().toISOString());
    if (first.kind !== "accepted") throw new Error("expected accepted claim");
    await markSyncRunning(drizzle(env.DB), id, first.runId);
    expect(await claimSessionRecoveryAttempt(env.DB, id, first.runId)).toBe(1);
    expect(await claimSessionRecoveryAttempt(env.DB, id, "stale-run")).toBeNull();
    expect(await claimSessionRecoveryAttempt(env.DB, id, first.runId)).toBe(2);

    await env.DB.prepare("UPDATE subscriptions SET sync_status='error' WHERE id=?")
      .bind(id).run();
    expect(await claimSessionRecoveryAttempt(env.DB, id, first.runId)).toBeNull();
    const terminal = await env.DB.prepare(
      "SELECT session_recovery_attempts FROM subscriptions WHERE id=?",
    ).bind(id).first<{ session_recovery_attempts: number }>();
    expect(terminal?.session_recovery_attempts).toBe(2);
    const second = await claimSubscriptionRun(env.DB, id, "cron", new Date().toISOString());
    if (second.kind !== "accepted") throw new Error("expected second accepted claim");
    await markSyncRunning(drizzle(env.DB), id, second.runId);
    expect(await claimSessionRecoveryAttempt(env.DB, id, second.runId)).toBe(1);
    const row = await env.DB.prepare(
      "SELECT session_recovery_attempts FROM subscriptions WHERE id=?",
    ).bind(id).first<{ session_recovery_attempts: number }>();
    expect(row?.session_recovery_attempts).toBe(1);
  });
});

describe("publicSyncFailure", () => {
  it("maps reauth failures to the rebind message", () => {
    expect(publicSyncFailure(new HarvestError("NEEDS_REAUTH"))).toEqual({
      code: "NEEDS_REAUTH",
      message: "登录状态已失效，请到账号设置重新绑定",
    });
  });

  it("keeps recoverable session states distinct from credential failure", () => {
    expect(publicSyncFailure(new HarvestError("SESSION_INACTIVE"))).toEqual({
      code: "SESSION_INACTIVE",
      message: "登录状态正在恢复，稍后自动重试",
    });
    expect(publicSyncFailure(new HarvestError("TGT_EXPIRED"))).toEqual({
      code: "TGT_EXPIRED",
      message: "登录状态正在恢复，稍后自动重试",
    });
  });

  it("shows a controlled temporary message for deadline/instance-replacement (no password blame)", () => {
    for (const code of ["BROWSER_DEADLINE", "BROWSER_INSTANCE_REPLACED"]) {
      const failure = publicSyncFailure(new HarvestError(code));
      expect(failure.code).toBe(code);
      expect(failure.message).toBe("同步服务暂时繁忙，请稍后重试");
      expect(failure.message).not.toContain("密码");
    }
  });

  it("keeps the generic message for a TERMINAL capacity failure (no stale queueing text)", () => {
    for (const code of ["BROWSER_BUSY"]) {
      const failure = publicSyncFailure(new HarvestError(code));
      expect(failure.code).toBe(code);
      expect(failure.message).not.toContain("排队");
    }
  });

  it("falls back to HARVEST_FAILED for non-stable-code messages", () => {
    expect(publicSyncFailure(new HarvestError("harvest exam body is not an object")).code)
      .toBe("HARVEST_FAILED");
  });

  it("renders an already-persisted aTrust error safely without treating it as queued", () => {
    expect(publicSyncFailure(new HarvestError("ATRUST_TRANSIENT"))).toEqual({
      code: "ATRUST_TRANSIENT",
      message: "学校系统暂时无法完成同步，请稍后重试",
    });
  });

  it("maps non-harvest errors to INTERNAL_ERROR", () => {
    expect(publicSyncFailure(new Error("boom"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "同步服务暂时不可用，请稍后重试",
    });
  });
});

describe("capacityWaitFailure", () => {
  it("shows the queueing message with the stable code preserved", () => {
    expect(capacityWaitFailure(new HarvestError("BROWSER_BUSY"))).toEqual({
      code: "BROWSER_BUSY",
      message: CAPACITY_WAIT_MESSAGE,
    });
  });
});

describe("isRetryableSyncFailure", () => {
  it("explicitly treats the browser capacity/transient codes as retryable (not by regex accident)", () => {
    for (const code of [
      "BROWSER_BUSY",
      "BROWSER_DEADLINE",
      "BROWSER_INSTANCE_REPLACED",
    ]) {
      expect(isRetryableSyncFailure(new HarvestError(code))).toBe(true);
    }
  });

  it("keeps user-action failures non-retryable", () => {
    for (const code of [
      "NEEDS_REAUTH",
      "FEATURE_NOT_ENABLED",
      "INVALID_HARVEST_URL",
    ]) {
      expect(isRetryableSyncFailure(new HarvestError(code))).toBe(false);
    }
  });

  it("keeps recoverable session states retryable", () => {
    expect(isRetryableSyncFailure(new HarvestError("SESSION_INACTIVE"))).toBe(true);
    expect(isRetryableSyncFailure(new HarvestError("TGT_EXPIRED"))).toBe(true);
  });
});
