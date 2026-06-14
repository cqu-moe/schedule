import { describe, it, expect } from "vitest";
import { resolveQuota, DENY_CAPS } from "./auth-rpc";

describe("resolveQuota", () => {
  it("null → Infinity", () => expect(resolveQuota(null)).toBe(Infinity));
  it("number passthrough", () => expect(resolveQuota(5)).toBe(5));
  it("0 → 0", () => expect(resolveQuota(0)).toBe(0));
});

describe("DENY_CAPS", () => {
  it("DENY_CAPS 全部拒绝", () => {
    expect(DENY_CAPS.sync).toBe(false);
    expect(DENY_CAPS.external).toBe(false);
    expect(DENY_CAPS.share).toBe(false);
    expect(DENY_CAPS.sub_limit).toBe(0);
    expect(DENY_CAPS.share_limit).toBe(0);
    expect(DENY_CAPS.manual_refresh).toBe(0);
  });
});
