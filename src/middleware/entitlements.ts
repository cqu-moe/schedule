import type { CalendarCaps } from "../services/auth-rpc";
import { resolveQuota } from "../services/auth-rpc";

/**
 * Thrown when a request fails a caps-based entitlement check. Routes catch this
 * and map it to `errorResponse(e.code, e.message, e.status)`.
 */
export class EntitlementError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

/** Boolean feature flags in CalendarCaps. */
type FlagKey = "sync" | "external" | "share";
/** Numeric quota limits in CalendarCaps. */
type QuotaKey = "sub_limit" | "share_limit" | "manual_refresh";

/**
 * Require a boolean feature flag to be granted.
 * @throws {EntitlementError} FEATURE_NOT_ENABLED (403) when the flag is false.
 */
export function assertFlag(caps: CalendarCaps, key: FlagKey, label: string): void {
  if (!caps[key]) {
    throw new EntitlementError("FEATURE_NOT_ENABLED", 403, `${label}未开通`);
  }
}

/**
 * Require the current count to be strictly below the quota limit.
 * `null` limit means unlimited (never throws); `0` limit always throws.
 * @throws {EntitlementError} QUOTA_EXCEEDED (409) when current >= limit.
 */
export function assertQuota(
  caps: CalendarCaps,
  key: QuotaKey,
  current: number,
  label: string,
): void {
  const limit = resolveQuota(caps[key]);
  if (current >= limit) {
    throw new EntitlementError("QUOTA_EXCEEDED", 409, `${label}已达上限 ${caps[key]}`);
  }
}
