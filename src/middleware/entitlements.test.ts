import { describe, it, expect } from "vitest";
import {
  EntitlementError,
  assertFlag,
  assertQuota,
} from "./entitlements";
import type { CalendarCaps } from "../services/auth-rpc";

/** Build a CalendarCaps with overrides on top of a permissive baseline. */
function caps(overrides: Partial<CalendarCaps> = {}): CalendarCaps {
  return {
    sync: true,
    external: true,
    share: true,
    sub_limit: 10,
    share_limit: 20,
    sync_interval: 60,
    manual_refresh: 20,
    ...overrides,
  };
}

describe("EntitlementError", () => {
  it("carries code and status", () => {
    const e = new EntitlementError("X_CODE", 418, "msg");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("X_CODE");
    expect(e.status).toBe(418);
    expect(e.message).toBe("msg");
  });
});

describe("assertFlag", () => {
  it("does not throw when flag is true", () => {
    expect(() => assertFlag(caps({ share: true }), "share", "共享链接")).not.toThrow();
  });

  it("throws FEATURE_NOT_ENABLED (403) when flag is false", () => {
    try {
      assertFlag(caps({ share: false }), "share", "共享链接");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EntitlementError);
      const err = e as EntitlementError;
      expect(err.code).toBe("FEATURE_NOT_ENABLED");
      expect(err.status).toBe(403);
      expect(err.message).toContain("共享链接");
    }
  });

  it("works for sync and external flags", () => {
    expect(() => assertFlag(caps({ sync: false }), "sync", "日历同步")).toThrow(EntitlementError);
    expect(() => assertFlag(caps({ external: false }), "external", "外部订阅")).toThrow(EntitlementError);
  });
});

describe("assertQuota", () => {
  it("does not throw when current is below limit", () => {
    expect(() => assertQuota(caps({ sub_limit: 10 }), "sub_limit", 5, "订阅数量")).not.toThrow();
  });

  it("throws QUOTA_EXCEEDED (409) when current equals limit", () => {
    try {
      assertQuota(caps({ sub_limit: 10 }), "sub_limit", 10, "订阅数量");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EntitlementError);
      const err = e as EntitlementError;
      expect(err.code).toBe("QUOTA_EXCEEDED");
      expect(err.status).toBe(409);
      expect(err.message).toContain("订阅数量");
    }
  });

  it("throws when current exceeds limit", () => {
    expect(() => assertQuota(caps({ share_limit: 3 }), "share_limit", 4, "共享链接")).toThrow(
      EntitlementError,
    );
  });

  it("never throws when limit is null (unlimited)", () => {
    expect(() =>
      assertQuota(caps({ sub_limit: null }), "sub_limit", 999999, "订阅数量"),
    ).not.toThrow();
  });

  it("throws when limit is 0 even at current 0", () => {
    expect(() => assertQuota(caps({ manual_refresh: 0 }), "manual_refresh", 0, "手动刷新")).toThrow(
      EntitlementError,
    );
  });
});
