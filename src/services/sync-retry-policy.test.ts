import { describe, it, expect } from "vitest";
import {
  capacityRetryDelay,
  CAPACITY_RETRY_MAX_ATTEMPTS,
  CAPACITY_RETRY_WINDOW_MS,
  sessionRecoveryRetryDelay,
  SESSION_RECOVERY_MAX_ATTEMPTS,
  SESSION_RECOVERY_WINDOW_MS,
} from "./sync-retry-policy";

const NOW = 1_800_000_000_000;

describe("capacityRetryDelay", () => {
  it("delays 60s with zero jitter and clamps jitter to [0, 30]", () => {
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, 0)).toBe(60);
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, 15.9)).toBe(75);
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, 30)).toBe(90);
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, 999)).toBe(90);
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, -5)).toBe(60);
  });

  it("returns null for non-capacity codes (they keep the original finite retry)", () => {
    expect(capacityRetryDelay("ATRUST_LOGIN_IN_FLIGHT", NOW - 60_000, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("PASSWORD_REJECTED", NOW - 60_000, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_DEADLINE", NOW - 60_000, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_INSTANCE_REPLACED", NOW - 60_000, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("HARVEST_FAILED", NOW - 60_000, NOW, 1, 0)).toBeNull();
  });

  it("returns null for missing/invalid/future firstRequestedAt", () => {
    expect(capacityRetryDelay("BROWSER_BUSY", Number.NaN, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", Number.POSITIVE_INFINITY, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", Number.NEGATIVE_INFINITY, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", NOW + 1_000, NOW, 1, 0)).toBeNull();
  });

  it("still waits at 44:59 but stops at exactly 45 minutes", () => {
    const justInside = NOW - (CAPACITY_RETRY_WINDOW_MS - 1_000);
    expect(capacityRetryDelay("BROWSER_BUSY", justInside, NOW, 44, 0)).toBe(60);
    const boundary = NOW - CAPACITY_RETRY_WINDOW_MS;
    expect(capacityRetryDelay("BROWSER_BUSY", boundary, NOW, 1, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", boundary - 60_000, NOW, 1, 0)).toBeNull();
  });

  it("still waits on the 44th attempt but stops at the 45th", () => {
    expect(
      capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, CAPACITY_RETRY_MAX_ATTEMPTS - 1, 0),
    ).toBe(60);
    expect(
      capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, CAPACITY_RETRY_MAX_ATTEMPTS, 0),
    ).toBeNull();
    expect(
      capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, CAPACITY_RETRY_MAX_ATTEMPTS + 10, 0),
    ).toBeNull();
  });

  it("returns null for non-positive-integer attempts (caller falls back to finite retry)", () => {
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 0, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, -2, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1.5, 0)).toBeNull();
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, Number.NaN, 0)).toBeNull();
  });

  it("treats non-finite jitter as 0", () => {
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, Number.NaN)).toBe(60);
    expect(capacityRetryDelay("BROWSER_BUSY", NOW - 60_000, NOW, 1, Number.POSITIVE_INFINITY)).toBe(60);
  });
});

describe("sessionRecoveryRetryDelay", () => {
  it("shares one recovery schedule across inactive and expired states", () => {
    expect(sessionRecoveryRetryDelay("TGT_EXPIRED", NOW - 1_000, NOW, 1)).toBe(60);
    expect(sessionRecoveryRetryDelay("SESSION_INACTIVE", NOW - 61_000, NOW, 2)).toBe(120);
    expect(sessionRecoveryRetryDelay("TGT_EXPIRED", NOW - 181_000, NOW, 3)).toBe(300);
    expect(sessionRecoveryRetryDelay("SESSION_INACTIVE", NOW - 481_000, NOW, 9)).toBe(300);
    expect(SESSION_RECOVERY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(10);
  });

  it("never puts credentials or WAF failures into the session recovery loop", () => {
    for (const code of ["NEEDS_REAUTH", "WAF_CHALLENGE", "HARVEST_TRANSIENT"]) {
      expect(sessionRecoveryRetryDelay(code, NOW - 1_000, NOW, 1)).toBeNull();
    }
  });

  it("stops at the persisted 30-minute boundary or attempt ceiling", () => {
    expect(sessionRecoveryRetryDelay(
      "SESSION_INACTIVE", NOW - SESSION_RECOVERY_WINDOW_MS + 1, NOW, 2,
    )).toBe(120);
    expect(sessionRecoveryRetryDelay(
      "SESSION_INACTIVE", NOW - SESSION_RECOVERY_WINDOW_MS, NOW, 2,
    )).toBeNull();
    expect(sessionRecoveryRetryDelay(
      "SESSION_INACTIVE", NOW - 1_000, NOW, SESSION_RECOVERY_MAX_ATTEMPTS,
    )).toBeNull();
  });

  it("fails closed for missing, future, or invalid persisted anchors", () => {
    expect(sessionRecoveryRetryDelay("SESSION_INACTIVE", Number.NaN, NOW, 1)).toBeNull();
    expect(sessionRecoveryRetryDelay("SESSION_INACTIVE", NOW + 1, NOW, 1)).toBeNull();
    expect(sessionRecoveryRetryDelay("SESSION_INACTIVE", NOW - 1, NOW, 0)).toBeNull();
  });
});
