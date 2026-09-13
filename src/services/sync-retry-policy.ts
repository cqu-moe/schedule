/**
 * Bounded capacity-wait retry policy for schedule-sync.
 *
 * BROWSER_BUSY (browser pool full) is a CAPACITY signal, not a real failure:
 * the sync can simply wait for a slot. It gets its own bounded retry branch
 * (60-90s delay, checked before the generic [30,120,300] backoff), bounded by
 * BOTH a 45-minute window (from the sync run's first request) and 45 attempts,
 * so every queue message has a definite end.
 *
 * All other failures keep the original finite retry behavior — raising the
 * queue platform max_retries to 45 does NOT extend their backoff.
 */

/** Stable failure codes that mean "browser capacity is temporarily full". */
export const CAPACITY_RETRY_CODES: ReadonlySet<string> = new Set([
  "BROWSER_BUSY",
]);

/** One sync run may wait for capacity at most 45 minutes from its first request… */
export const CAPACITY_RETRY_WINDOW_MS = 45 * 60_000;
/** …and at most 45 delivery attempts (the queue platform max_retries is 45). */
export const CAPACITY_RETRY_MAX_ATTEMPTS = 45;

/**
 * Seconds to delay the next capacity retry, or null when the run must STOP
 * waiting: non-capacity code, missing/invalid/future firstRequestedAt, the
 * 45-minute window reached, the 45-attempt ceiling reached, or non-positive-
 * integer attempts. Callers treat null as "fall back to the original finite
 * retry" when the inputs were invalid, and as "capacity budget exhausted,
 * fail the run" when they were valid. A non-finite jitter counts as 0.
 */
export function capacityRetryDelay(
  code: string,
  firstRequestedAt: number,
  now: number,
  attempts: number,
  jitterSeconds: number,
): number | null {
  if (!CAPACITY_RETRY_CODES.has(code)) return null;
  if (!Number.isFinite(firstRequestedAt) || !Number.isFinite(now)) return null;
  if (now < firstRequestedAt) return null;
  if (now - firstRequestedAt >= CAPACITY_RETRY_WINDOW_MS) return null;
  if (!Number.isInteger(attempts) || attempts < 1) return null;
  if (attempts >= CAPACITY_RETRY_MAX_ATTEMPTS) return null;
  const jitter = Number.isFinite(jitterSeconds) ? Math.floor(jitterSeconds) : 0;
  return 60 + Math.max(0, Math.min(30, jitter));
}
