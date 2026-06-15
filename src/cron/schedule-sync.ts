import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  subscriptions,
  PERSONAL_SOURCE_TYPES,
  type SourceType,
  type ExternalSourceType,
} from "../db/schema";
import type { Env } from "../types";
import type { CalendarCaps } from "../services/auth-rpc";
import { CQUAPIClient, CQUAPIError } from "../services/cqu-api";
import { getCquBearer, resolveOwnStudentId, invalidateCquBearer } from "../services/cqu-bearer";
import { spreadEnqueue } from "../utils/queue";
import {
  fetchSessionContextCached,
  fetchSessionContextFor,
  fetchPersonalScheduleCached,
  buildPersonalSyncResult,
  buildExternalSyncResult,
  applySyncResult,
  preGenerateIcs,
} from "../services/sync";

/** Queue message: one subscription to sync for a given auth user. */
export interface ScheduleSyncMessage {
  subscriptionId: string;
  userId: string;
  /**
   * What enqueued this message. `"cron"` messages are re-checked for due-ness in
   * the consumer — the hourly producer spreads each due batch over
   * {@link SYNC_SPREAD_SECONDS} (> the 1h cron period), so intervening cron runs
   * re-enqueue subscriptions whose delayed message has not executed yet.
   * `"manual"` (user refresh), `"initial"` (just-created subscription), and
   * legacy/undefined always sync, bypassing the due re-check.
   */
  trigger?: "cron" | "manual" | "initial";
}

/** Default sync interval (minutes) when caps are missing/unparseable. */
const DEFAULT_SYNC_INTERVAL_MINUTES = 1440;

/** TTL (seconds) for the caps:<userId> KV cache; mirrors the session middleware. */
const CAPS_CACHE_TTL_SECONDS = 3600;

/**
 * Spread window (seconds) over which to scatter enqueued sync messages, AND the
 * hard per-message delay cap. Set to the 1h cron period so each batch is fully
 * delivered before the next hourly run — spreading beyond the cron period would
 * re-enqueue not-yet-executed subscriptions every intervening run (the source of
 * the duplicate-sync churn; the consumer's due re-check is the backstop, staying
 * within 1h avoids the churn entirely).
 */
const SYNC_SPREAD_SECONDS = 3600;

/**
 * Producer: pick subscriptions due for sync and enqueue them.
 *
 * For each subscription, the per-user `sync_interval` (minutes) is read from the
 * `caps:<userId>` KV cache (written by the session middleware on login). When a
 * cap is missing or unparseable, the conservative {@link DEFAULT_SYNC_INTERVAL_MINUTES}
 * default is used. A subscription is due when it has never synced (`lastSyncedAt`
 * null) or `now - lastSyncedAt >= interval`.
 *
 * NOTE: this producer only runs on the hourly cron, so the cron period (1h) is
 * the hard FLOOR on effective auto-refresh frequency. `sync_interval` therefore
 * only differentiates tiers at or above 1h (hourly / 6h / daily…); any value
 * below 60 min still resolves to once per hour — it does NOT yield sub-hourly
 * refresh. Genuine sub-hourly refresh would require a higher-frequency cron.
 */
export async function enqueueScheduleSync(env: Env): Promise<void> {
  console.log(
    JSON.stringify({ event: "cron.schedule_sync.start", message: "Selecting due subscriptions" }),
  );
  const db = drizzle(env.DB);

  const allSubs = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      sourceType: subscriptions.sourceType,
      isActive: subscriptions.isActive,
      lastSyncedAt: subscriptions.lastSyncedAt,
    })
    .from(subscriptions);

  if (allSubs.length === 0) {
    console.log(
      JSON.stringify({ event: "cron.schedule_sync.skip", message: "No subscriptions" }),
    );
    return;
  }

  // Cache caps per user to avoid re-reading KV for each subscription.
  const capsCache = new Map<string, CalendarCaps | null>();
  const now = Date.now();
  const due: ScheduleSyncMessage[] = [];

  for (const sub of allSubs) {
    let caps = capsCache.get(sub.userId);
    if (caps === undefined) {
      caps = await readCaps(env, sub.userId);
      capsCache.set(sub.userId, caps);
    }

    const entitled = isCalendarEntitled(sub.sourceType, caps);

    // Reconcile is_active (hard revocation): when caps are KNOWN, flip the row to
    // match entitlement — revoked → inactive (public links 403), re-granted →
    // active again. Skip when caps are null (transient outage) to avoid flapping.
    if (caps !== null && sub.isActive !== entitled) {
      await db
        .update(subscriptions)
        .set({ isActive: entitled, updatedAt: new Date().toISOString() })
        .where(eq(subscriptions.id, sub.id));
    }

    // Entitlement gate: don't sync subs whose required cap was revoked.
    if (!entitled) continue;

    if (isDue(sub.lastSyncedAt, capsSyncInterval(caps), now)) {
      due.push({ subscriptionId: sub.id, userId: sub.userId, trigger: "cron" });
    }
  }

  if (due.length === 0) {
    console.log(
      JSON.stringify({
        event: "cron.schedule_sync.skip",
        total: allSubs.length,
        message: "No subscriptions due",
      }),
    );
    return;
  }

  await spreadEnqueue(
    env.SCHEDULE_SYNC_QUEUE,
    due,
    (m) => ({ body: m }),
    SYNC_SPREAD_SECONDS,
    10,
    SYNC_SPREAD_SECONDS, // hard-cap every delay at 1h so nothing spills past the next cron
  );

  console.log(
    JSON.stringify({
      event: "cron.schedule_sync.enqueued",
      count: due.length,
      total: allSubs.length,
      message: `Enqueued ${due.length}/${allSubs.length} due subscriptions`,
    }),
  );
}

/**
 * Read a user's calendar caps for offline (cron) scheduling + entitlement.
 *
 * Fast path: the `caps:<userId>` KV entry written by the session middleware on
 * login. On a cache miss (the 1h caps TTL expired while the user was inactive)
 * refresh from the auth RPC ({@link AuthService.getCaps}) and re-cache, so a
 * configured short interval (and a revoked flag) keep being honored offline.
 * Returns `null` only when no caps are resolvable at all.
 */
async function readCaps(env: Env, userId: string): Promise<CalendarCaps | null> {
  try {
    const cached = await env.CACHE.get(`caps:${userId}`, "json");
    if (cached) return cached as CalendarCaps;
  } catch {
    // ignore and try the RPC refresh below
  }

  try {
    const caps = await env.AUTH?.getCaps?.(userId);
    if (caps?.calendar) {
      await env.CACHE.put(`caps:${userId}`, JSON.stringify(caps.calendar), {
        expirationTtl: CAPS_CACHE_TTL_SECONDS,
      }).catch(() => {});
      return caps.calendar;
    }
  } catch {
    // fall through to null
  }
  return null;
}

/** Resolve `sync_interval` (minutes) from caps, falling back to the conservative default. */
function capsSyncInterval(caps: CalendarCaps | null): number {
  const raw = caps?.sync_interval;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_MINUTES;
}

/**
 * Entitlement gate for automatic syncing: personal subs require the `sync` cap,
 * external subs require `external`.
 *
 * FAILS CLOSED: when caps are UNRESOLVABLE (null — KV miss and `getCaps`
 * unavailable/failed) we treat the sub as NOT entitled, so a revoked user whose
 * caps can't be confirmed cannot keep syncing (the hard-revocation invariant the
 * is_active model depends on). This requires a RELIABLE offline caps source —
 * auth must implement `getCaps` (see cqu-moe/auth#6); otherwise every user
 * inactive past the caps KV TTL resolves to null and stops auto-syncing.
 *
 * NOTE: is_active is flipped inactive only on a CONFIRMED revocation (caps
 * resolved, flag false) — never on a transient null — so links don't flap during
 * an auth outage (see the producer reconcile guard and the consumer skip branch).
 */
function isCalendarEntitled(sourceType: SourceType, caps: CalendarCaps | null): boolean {
  if (!caps) return false;
  return PERSONAL_SOURCE_TYPES.has(sourceType) ? caps.sync : caps.external;
}

/** A subscription is due when never synced, or last sync is older than `interval` minutes. */
function isDue(lastSyncedAt: string | null, intervalMinutes: number, now: number): boolean {
  if (!lastSyncedAt) return true;
  const last = Date.parse(lastSyncedAt);
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMinutes * 60_000;
}

/**
 * Consumer: process a batch of per-subscription sync messages.
 *
 * Each message resolves a CQU bearer via {@link getCquBearer} (auth 拓扑①). A
 * null bearer (inactive auth session / exchange failure) is logged and acked —
 * never retried — so an offline user does not block the batch.
 */
export async function processScheduleSyncBatch(
  batch: MessageBatch<ScheduleSyncMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);

  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const { subscriptionId, userId, trigger } = message.body;
      try {
        const [sub] = await db
          .select({
            id: subscriptions.id,
            sourceType: subscriptions.sourceType,
            sourceId: subscriptions.sourceId,
            sourceName: subscriptions.sourceName,
            sessionId: subscriptions.sessionId,
            sessionName: subscriptions.sessionName,
            lastSyncedAt: subscriptions.lastSyncedAt,
          })
          .from(subscriptions)
          .where(eq(subscriptions.id, subscriptionId))
          .limit(1);

        if (!sub) {
          // Subscription deleted between enqueue and processing.
          message.ack();
          return;
        }

        const caps = await readCaps(env, userId);

        // Entitlement gate (all triggers): a revoked calendar cap stops syncing
        // existing subscriptions — including messages enqueued before a downgrade
        // and manual/initial refreshes by a now-ineligible user.
        if (!isCalendarEntitled(sub.sourceType, caps)) {
          // CONFIRMED revocation (caps resolved, flag false): flip inactive NOW
          // (don't wait for the producer reconcile) so public links stop serving.
          // UNRESOLVED caps (null): fail closed on syncing, but leave is_active
          // untouched — a transient outage must not flap the links off.
          if (caps !== null) {
            await db
              .update(subscriptions)
              .set({ isActive: false, updatedAt: new Date().toISOString() })
              .where(eq(subscriptions.id, subscriptionId));
          }
          console.log(
            JSON.stringify({
              event: "queue.schedule_sync.skip_not_entitled",
              subscriptionId,
              capsResolved: caps !== null,
              message: caps !== null
                ? "Calendar capability revoked; marked inactive, skipping"
                : "Caps unresolved; failing closed (skip sync, keep is_active)",
            }),
          );
          message.ack();
          return;
        }

        // Idempotency guard for cron-triggered syncs: the hourly producer spreads
        // each due batch over SYNC_SPREAD_SECONDS (> the 1h cron period), so
        // intervening cron runs re-enqueue a subscription whose delayed message
        // has not executed yet. Re-check due-ness here so only the first delivery
        // syncs and later duplicates no-op — preventing a subscription from being
        // synced several times per interval and multiplying upstream CQU traffic.
        // Manual/initial refreshes skip this guard.
        if (trigger === "cron" && !isDue(sub.lastSyncedAt, capsSyncInterval(caps), Date.now())) {
          console.log(
            JSON.stringify({
              event: "queue.schedule_sync.skip_not_due",
              subscriptionId,
              message: "Already synced within interval; dropping duplicate",
            }),
          );
          message.ack();
          return;
        }

        const bearer = await getCquBearer(env, userId);
        if (!bearer) {
          console.log(
            JSON.stringify({
              event: "queue.schedule_sync.skip_no_bearer",
              subscriptionId,
              message: "No CQU bearer available; skipping",
            }),
          );
          message.ack();
          return;
        }

        const api = new CQUAPIClient(bearer);
        const ctx = await fetchSessionContextCached(api, env.CACHE);
        const fallback = { sessionName: sub.sessionName };

        if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
          // Personal subscription: the student ID is resolved from the bearer's
          // own authenticated subject — NEVER from the stored sub.sourceId
          // (which is a client-supplied, untrusted value). This prevents a
          // crafted sourceId from leaking another student's private schedule.
          const studentId = resolveOwnStudentId(bearer, userId);
          if (!studentId) {
            console.log(
              JSON.stringify({
                event: "queue.schedule_sync.skip_no_student_id",
                subscriptionId,
                message: "No student ID resolvable from bearer; skipping",
              }),
            );
            message.ack();
            return;
          }
          const personalData = await fetchPersonalScheduleCached(
            api,
            studentId,
            ctx,
            env.CACHE,
          );
          const ics = preGenerateIcs(personalData, studentId);
          const result = buildPersonalSyncResult(sub.sourceType, personalData, ics);
          await applySyncResult(db, sub.id, result, ctx, fallback);
        } else {
          // External subscription: sourceId is the target ID; use it as the ICS
          // UID namespace (stable per subscription). Honor the subscription's
          // requested session when set (else current) so a past-semester sub
          // exports THAT semester and keeps its session, instead of silently
          // switching to current and colliding with sibling-session subs.
          const targetCtx =
            sub.sessionId && sub.sessionId !== ctx.sessionId
              ? await fetchSessionContextFor(api, sub.sessionId)
              : ctx;
          const result = await buildExternalSyncResult(
            api,
            sub.sourceType as ExternalSourceType,
            sub.sourceId,
            sub.sourceId,
            targetCtx,
          );
          await applySyncResult(db, sub.id, result, targetCtx, fallback);
        }

        console.log(
          JSON.stringify({
            event: "queue.schedule_sync.subscription_synced",
            subscriptionId,
            sourceType: sub.sourceType,
            message: "Subscription synced",
          }),
        );

        message.ack();
      } catch (e) {
        // A 401 means CQU rejected the bearer (expired/revoked/rebound) — drop the
        // cached bearer so the retry re-mints (a revoked account then resolves to
        // SESSION_INACTIVE and is skipped instead of looping on a stale token).
        if (e instanceof CQUAPIError && e.statusCode === 401) {
          await invalidateCquBearer(env, userId);
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            event: "queue.schedule_sync.failed",
            subscriptionId,
            error: msg,
            message: "Schedule sync failed",
          }),
        );
        message.retry();
      }
    }),
  );
}
