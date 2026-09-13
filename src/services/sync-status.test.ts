import { describe, it, expect } from "vitest";
import { HarvestError } from "./cqu-harvest";
import {
  CAPACITY_WAIT_MESSAGE,
  capacityWaitFailure,
  isRetryableSyncFailure,
  publicSyncFailure,
} from "./sync-status";

describe("publicSyncFailure", () => {
  it("maps reauth failures to the rebind message", () => {
    expect(publicSyncFailure(new HarvestError("NEEDS_REAUTH"))).toEqual({
      code: "NEEDS_REAUTH",
      message: "登录状态已失效，请到账号设置重新绑定",
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
      "SESSION_INACTIVE",
      "FEATURE_NOT_ENABLED",
      "INVALID_HARVEST_URL",
    ]) {
      expect(isRetryableSyncFailure(new HarvestError(code))).toBe(false);
    }
  });
});
