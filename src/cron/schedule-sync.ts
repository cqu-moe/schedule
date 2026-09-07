import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import {
  subscriptions,
  notificationState,
  PERSONAL_SOURCE_TYPES,
  EXTERNAL_SOURCE_TYPES,
  type SourceType,
} from "../db/schema";
import type { Env } from "../types";
import type { CalendarCaps } from "../services/auth-rpc";
import { spreadEnqueue, SpreadEnqueueError } from "../utils/queue";
import { fetchPersonalHarvest, HarvestError } from "../services/cqu-harvest";
import {
  buildPersonalSyncResult,
  applySyncResult,
  preGenerateIcs,
} from "../services/sync";
import {
  markSyncError,
  markSyncRetrying,
  markSyncRunning,
  markSyncSuccess,
  publicSyncFailure,
  queueSyncRun,
  isRetryableSyncFailure,
} from "../services/sync-status";
import type { PersonalScheduleData } from "../services/sync";
import {
  createNotificationId,
  diffFutureSchedule,
  hashSchedule,
  normalizeSchedule,
  parseScheduleSnapshot,
  renderScheduleChangeEmail,
} from "../services/schedule-notifications";

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
  /** Identifies this attempt so delayed/stale queue messages cannot overwrite a newer run. */
  runId?: string;
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
const SYNC_RETRY_DELAYS_SECONDS = [30, 120, 300] as const;

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
      syncStatus: subscriptions.syncStatus,
      syncRequestedAt: subscriptions.syncRequestedAt,
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
    // This MUST run before the external freeze-skip below: an owner who loses the
    // `external` cap while external subs are frozen still needs the revoked row
    // flipped inactive so its public link stops serving (the freeze-skip only
    // suppresses ENQUEUE, not revocation enforcement).
    if (caps !== null && sub.isActive !== entitled) {
      await db
        .update(subscriptions)
        .set({ isActive: entitled, updatedAt: new Date().toISOString() })
        .where(eq(subscriptions.id, sub.id));
    }

    // 外部订阅 HARD-SKIP 入队(Option A,无条件,与 consumer 一致):本架构没有外部
    // 课表的 harvest 路径(该能力已在本 PR 移除),外部订阅永不入队同步。若仍入队,
    // consumer 会 ack-skip 但不更新 lastSyncedAt,每次 hourly cron 又因"due"重新入队
    // → 永不停止的空转入队 + 日志刷屏。放在 is_active 对账之后,故被吊销 external 权益
    // 的外部订阅仍会被对账成 inactive(吊销照常生效),只是不入队。EXTERNAL_DISABLED
    // 不参与此处判断,仅控制面向用户的提示/守卫。
    if (EXTERNAL_SOURCE_TYPES.has(sub.sourceType)) continue;

    // Entitlement gate: don't sync subs whose required cap was revoked.
    if (!entitled) continue;

    const activeRunAge = sub.syncRequestedAt ? now - Date.parse(sub.syncRequestedAt) : Infinity;
    const hasActiveRun = (sub.syncStatus === "queued" || sub.syncStatus === "running")
      && Number.isFinite(activeRunAge)
      && activeRunAge < 2 * 60 * 60_000;
    if (!hasActiveRun && isDue(sub.lastSyncedAt, capsSyncInterval(caps), now)) {
      const runId = await queueSyncRun(db, sub.id, "cron");
      due.push({ subscriptionId: sub.id, userId: sub.userId, trigger: "cron", runId });
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

  try {
    await spreadEnqueue(
      env.SCHEDULE_SYNC_QUEUE,
      due,
      (m) => ({ body: m }),
      SYNC_SPREAD_SECONDS,
      10,
      SYNC_SPREAD_SECONDS, // hard-cap every delay at 1h so nothing spills past the next cron
    );
  } catch (error) {
    const enqueued = error instanceof SpreadEnqueueError ? error.enqueued : 0;
    await Promise.all(due.slice(enqueued).map((item) =>
      markSyncError(db, item.subscriptionId, item.runId!, {
        code: "QUEUE_UNAVAILABLE",
        message: "同步服务暂时不可用，请稍后重试",
      }),
    ));
    throw error;
  }

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
    const caps = await env.AUTH?.getCaps?.({
      clientId: env.CALENDAR_CLIENT_ID,
      clientSecret: env.CALENDAR_CLIENT_SECRET,
      userId,
    });
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
 * Each personal message harvests the 课表 through the user's已登录浏览器 via
 * {@link fetchPersonalHarvest} (auth 拓扑① organic harvest). A harvest failure
 * Transient WAF/aTrust/network failures are retried with bounded backoff. Errors
 * that require user action are persisted and acknowledged immediately.
 */
export async function processScheduleSyncBatch(
  batch: MessageBatch<ScheduleSyncMessage>,
  env: Env,
): Promise<void> {
  const db = drizzle(env.DB);
  type PersonalHarvest = Awaited<ReturnType<typeof fetchPersonalHarvest>>;
  const personalHarvestByUser = new Map<string, Promise<PersonalHarvest>>();
  const personalNotificationByUser = new Map<string, Promise<void>>();

  function fetchBatchPersonalHarvest(userId: string): Promise<PersonalHarvest> {
    const existing = personalHarvestByUser.get(userId);
    if (existing) return existing;
    const pending = fetchPersonalHarvest(env, userId);
    personalHarvestByUser.set(userId, pending);
    return pending;
  }

  function processBatchPersonalNotification(
    userId: string,
    data: PersonalScheduleData,
    caps: CalendarCaps | null,
  ): Promise<void> {
    const existing = personalNotificationByUser.get(userId);
    if (existing) return existing;
    const pending = processPersonalNotification(db, env, userId, data, caps);
    personalNotificationByUser.set(userId, pending);
    return pending;
  }

  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const { subscriptionId, userId, trigger } = message.body;
      let runId = message.body.runId;
      let syncTargetIds = [subscriptionId];
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
            syncRunId: subscriptions.syncRunId,
          })
          .from(subscriptions)
          .where(eq(subscriptions.id, subscriptionId))
          .limit(1);

        if (!sub) {
          // Subscription deleted between enqueue and processing.
          message.ack();
          return;
        }

        if (runId && sub.syncRunId !== runId) {
          console.log(JSON.stringify({
            event: "queue.schedule_sync.skip_stale",
            subscriptionId,
            message: "A newer sync run superseded this queue message",
          }));
          message.ack();
          return;
        }
        if (!runId) {
          runId = await queueSyncRun(db, subscriptionId, trigger ?? "admin");
        }
        if (!(await markSyncRunning(db, subscriptionId, runId))) {
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
          await markSyncError(db, subscriptionId, runId, caps !== null
            ? { code: "FEATURE_NOT_ENABLED", message: "日历同步未开通" }
            : { code: "CAPS_UNAVAILABLE", message: "暂时无法确认同步权限，请稍后重试" });
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
          await markSyncSuccess(db, subscriptionId, runId);
          message.ack();
          return;
        }

        // 外部订阅 HARD-SKIP(Option A,无条件):本架构没有外部课表的 harvest 路径
        // ——瑞数化后 external `{type}/table-detail` POST 同属写专守、无可自动 fire 的
        // 深链,该能力已在本 PR 移除(详见 config/external-availability.ts)。外部订阅
        // 绝不可走个人 harvest 路径:否则 fetchPersonalHarvest + buildPersonalSyncResult
        // 会把订阅主人(owner)自己的个人课表写进这条对外公开链接,污染数据。因此无论
        // EXTERNAL_DISABLED 真假都直接 ack 跳过(不 harvest、不改 lastSyncedAt,数据冻结
        // 在最后状态)。EXTERNAL_DISABLED 仅控制面向用户的提示/守卫,不参与此处判断;
        // 重新启用外部需未来跨仓任务重建其 harvest/search 路径。
        if (EXTERNAL_SOURCE_TYPES.has(sub.sourceType)) {
          console.log(
            JSON.stringify({
              event: "queue.schedule_sync.skip_external_frozen",
              subscriptionId,
              sourceType: sub.sourceType,
              message: "External subscription has no harvest path; acking without sync",
            }),
          );
          await markSyncError(db, subscriptionId, runId, {
            code: "EXTERNAL_SYNC_UNAVAILABLE",
            message: "外部订阅同步暂不可用",
          });
          message.ack();
          return;
        }

        // One personal harvest returns both courses and exams. Materialize that
        // result into every existing personal view (all/courses/exams) so clicking
        // any one of the trio never causes another upstream request.
        const personalSubs = await db
          .select({
            id: subscriptions.id,
            sourceType: subscriptions.sourceType,
            sourceId: subscriptions.sourceId,
            sessionName: subscriptions.sessionName,
            syncRunId: subscriptions.syncRunId,
          })
          .from(subscriptions)
          .where(and(
            eq(subscriptions.userId, userId),
            inArray(subscriptions.sourceType, [...PERSONAL_SOURCE_TYPES]),
          ));
        const runTargets = personalSubs
          .filter(target => target.syncRunId === runId)
          .map(target => target.id);
        syncTargetIds = runTargets.length > 0 ? runTargets : [subscriptionId];
        await Promise.all(
          syncTargetIds
            .filter(targetId => targetId !== subscriptionId)
            .map(targetId => markSyncRunning(db, targetId, runId!)),
        );

        const { ctx, data: personalData } = await fetchBatchPersonalHarvest(userId);
        // ICS UID namespace: the harvest path has no 学号, but sub.sourceId is
        // pinned to the auth user.id for personal subs (see routes/v2/subscriptions
        // "pin it to the trusted auth user.id"), so it is per-user-stable and
        // deterministic per subscription — the property the ICS UID requires.
        // Using ctx.semesterInfo.id (the term/semester id, e.g. "1060") would be
        // identical for every user in a semester and collide UIDs across users.
        const uidNamespace = sub.sourceId;
        const ics = preGenerateIcs(personalData, uidNamespace);
        await Promise.all(personalSubs.map(target => applySyncResult(
          db,
          target.id,
          buildPersonalSyncResult(target.sourceType, personalData, ics),
          ctx,
          { sessionName: target.sessionName },
          target.syncRunId === runId ? runId : undefined,
        )));
        try {
          await processBatchPersonalNotification(userId, personalData, caps);
        } catch {
          console.error(JSON.stringify({
            event: "queue.schedule_notification.processing_failed",
            userId,
            reason: "notification_processing_failed",
          }));
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
        if (e instanceof HarvestError) {
          const attempt = message.attempts ?? 1;
          const failure = publicSyncFailure(e);
          if (runId && isRetryableSyncFailure(e) && attempt <= SYNC_RETRY_DELAYS_SECONDS.length) {
            const delaySeconds = SYNC_RETRY_DELAYS_SECONDS[attempt - 1];
            await Promise.all(syncTargetIds.map(targetId =>
              markSyncRetrying(db, targetId, runId!, failure)));
            console.warn(JSON.stringify({
              event: "queue.schedule_sync.harvest_retry",
              subscriptionId,
              attempt,
              delaySeconds,
              error: e.message,
              message: "Transient harvest failure; scheduling retry",
            }));
            message.retry({ delaySeconds });
            return;
          }
          if (runId) await Promise.all(syncTargetIds.map(targetId =>
            markSyncError(db, targetId, runId!, failure)));
          console.warn(
            JSON.stringify({
              event: "queue.schedule_sync.harvest_failed",
              subscriptionId,
              error: e.message,
              attempt,
              message: "Harvest failed permanently or retries exhausted",
            }),
          );
          message.ack();
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        const attempt = message.attempts ?? 1;
        const failure = publicSyncFailure(e);
        if (runId && attempt <= SYNC_RETRY_DELAYS_SECONDS.length) {
          const delaySeconds = SYNC_RETRY_DELAYS_SECONDS[attempt - 1];
          await Promise.all(syncTargetIds.map(targetId =>
            markSyncRetrying(db, targetId, runId!, failure)));
          console.error(JSON.stringify({
            event: "queue.schedule_sync.retry",
            subscriptionId,
            attempt,
            delaySeconds,
            error: msg,
            message: "Schedule sync failed; scheduling retry",
          }));
          message.retry({ delaySeconds });
          return;
        }
        if (runId) await Promise.all(syncTargetIds.map(targetId =>
          markSyncError(db, targetId, runId!, failure)));
        console.error(
          JSON.stringify({
            event: "queue.schedule_sync.failed",
            subscriptionId,
            error: msg,
            message: "Schedule sync failed",
          }),
        );
        message.ack();
      }
    }),
  );
}

async function processPersonalNotification(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  data: PersonalScheduleData,
  caps: CalendarCaps | null,
): Promise<void> {
  const now = new Date();
  const snapshot = normalizeSchedule(data);
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotHash = await hashSchedule(snapshot);
  const state = await db
    .select()
    .from(notificationState)
    .where(eq(notificationState.userId, userId))
    .get();

  const advanceBaseline = async () => {
    const timestamp = now.toISOString();
    await db
      .insert(notificationState)
      .values({
        userId,
        enabled: state?.enabled ?? false,
        snapshotJson,
        snapshotHash,
        createdAt: state?.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: notificationState.userId,
        set: { snapshotJson, snapshotHash, updatedAt: timestamp },
      });
  };

  const previous = parseScheduleSnapshot(state?.snapshotJson ?? null);
  if (!previous || !state?.snapshotHash) {
    await advanceBaseline();
    return;
  }
  if (state.snapshotHash === snapshotHash) {
    await advanceBaseline();
    return;
  }
  if (!state.enabled || caps?.change_notification !== true) {
    await advanceBaseline();
    return;
  }

  const diff = diffFutureSchedule(previous, snapshot, now);
  if (diff.total === 0) {
    await advanceBaseline();
    return;
  }

  const rendered = renderScheduleChangeEmail(diff);
  const notificationId = await createNotificationId(userId, state.snapshotHash, snapshotHash);
  try {
    await env.SCHEDULE_NOTIFICATION_QUEUE.send({
      version: 1,
      notificationId,
      userId,
      ...rendered,
      createdAt: now.toISOString(),
    });
    await advanceBaseline();
    console.log(JSON.stringify({
      event: "queue.schedule_notification.enqueued",
      notificationId,
      userId,
      changes: diff.total,
    }));
  } catch {
    console.error(JSON.stringify({
      event: "queue.schedule_notification.enqueue_failed",
      notificationId,
      userId,
      reason: "queue_send_failed",
    }));
  }
}
