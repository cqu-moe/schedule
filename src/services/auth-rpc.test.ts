import { describe, it, expect } from "vitest";
import { resolveQuota } from "./auth-rpc";

describe("resolveQuota", () => {
  it("null → Infinity", () => expect(resolveQuota(null)).toBe(Infinity));
  it("number passthrough", () => expect(resolveQuota(5)).toBe(5));
  it("0 → 0", () => expect(resolveQuota(0)).toBe(0));
  // Fail closed: a partial caps object with a MISSING numeric quota must deny
  // (treat as 0), never grant unlimited (`current >= undefined` is always false).
  it("undefined → 0 (fail closed)", () => expect(resolveQuota(undefined)).toBe(0));
  it("NaN → 0 (fail closed)", () => expect(resolveQuota(Number.NaN)).toBe(0));
});
