import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc, asc, sql, inArray, isNull, lte, or } from "drizzle-orm";
import {
  subscriptions,
  calendarLinks,
  LINK_FORMATS,
  SOURCE_TYPES,
  EXTERNAL_SOURCE_TYPES,
  PERSONAL_SOURCE_TYPES,
  type SourceType,
} from "../../db/schema";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, assertQuota, EntitlementError } from "../../middleware/entitlements";
import { resolveQuota } from "../../services/auth-rpc";
import { errorResponse } from "../../utils/error";
import { externalUnavailableResponse } from "../../config/external-availability";
import { generateUniqueToken, linkTokenExists } from "../../utils/token";
import { parseFormats, buildCalendarUrl } from "../../services/links";
import { CHINA_TZ_OFFSET_MS } from "../../utils/time";
import type { ScheduleSyncMessage } from "../../cron/schedule-sync";
import { markSyncError, queueSyncRuns } from "../../services/sync-status";

const app = new Hono<SessionEnv>();

/** Max length for a user-supplied link label. */
const LABEL_MAX_LEN = 100;
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60_000;

const SOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(SOURCE_TYPES);

/** Serialize a calendar_links row into the public link summary shape. */
interface LinkSummaryRow {
  id: string;
  token: string;
  label: string | null;
  formats: string;
  isDefault: boolean;
}
function toLinkSummary(link: LinkSummaryRow) {
  let formats: string[];
  try {
    formats = JSON.parse(link.formats) as string[];
  } catch {
    formats = [];
  }
  return {
    id: link.id,
    token: link.token,
    label: link.label,
    formats,
    is_default: link.isDefault,
  };
}

/** Map an EntitlementError to a JSON error response; rethrow anything else. */
function entitlementError(e: unknown): Response {
  if (e instanceof EntitlementError) {
    return errorResponse(e.code, e.message, e.status);
  }
  throw e;
}

// ── GET / — list the current user's subscriptions (with link summaries) ──────
app.get("/", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .orderBy(desc(subscriptions.isPersonal), asc(subscriptions.createdAt));

  // Fetch all links for these subscriptions in one query, then group.
  const subIds = subs.map((s) => s.id);
  const linksBySub = new Map<string, ReturnType<typeof toLinkSummary>[]>();
  if (subIds.length > 0) {
    const links = await db
      .select()
      .from(calendarLinks)
      .innerJoin(subscriptions, eq(calendarLinks.subscriptionId, subscriptions.id))
      .where(eq(subscriptions.userId, user.id));
    for (const row of links) {
      const list = linksBySub.get(row.calendar_links.subscriptionId) ?? [];
      list.push(toLinkSummary(row.calendar_links));
      linksBySub.set(row.calendar_links.subscriptionId, list);
    }
  }

  return c.json({
    subscriptions: subs.map((sub) => ({
      ...serializeSubscription(sub),
      links: linksBySub.get(sub.id) ?? [],
    })),
    count: subs.length,
  });
});

// ── GET /:sid — single subscription (404 if not owned by current user) ───────
app.get("/:sid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, sid), eq(subscriptions.userId, user.id)))
    .limit(1);

  if (!sub) return errorResponse("NOT_FOUND", "订阅不存在", 404);

  const links = await db
    .select()
    .from(calendarLinks)
    .where(eq(calendarLinks.subscriptionId, sub.id))
    .orderBy(desc(calendarLinks.isDefault), asc(calendarLinks.createdAt));

  return c.json({
    ...serializeSubscription(sub),
    links: links.map(toLinkSummary),
  });
});

// ── POST / — create a subscription + its default (all-format) link ───────────
app.post("/", async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;
  const db = drizzle(c.env.DB);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("INVALID_INPUT", "无效的 JSON 请求体", 400);
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const sourceType = body.sourceType;
  const sourceId = body.sourceId;
  const sourceName = body.sourceName;

  if (typeof sourceType !== "string" || !SOURCE_TYPE_SET.has(sourceType)) {
    return errorResponse("INVALID_INPUT", "sourceType 无效", 400);
  }
  // sourceType is now known-valid; personal types ignore (and pin) sourceId, so
  // it is OPTIONAL for them. External types still require a non-empty sourceId.
  const isPersonalType = PERSONAL_SOURCE_TYPES.has(sourceType as SourceType);
  if (!isPersonalType && (typeof sourceId !== "string" || sourceId.length === 0)) {
    return errorResponse("INVALID_INPUT", "sourceId 必填", 400);
  }
  if (typeof sourceId === "string" && sourceId.length > 100) {
    return errorResponse("INVALID_INPUT", "sourceId 长度不能超过 100", 400);
  }
  if (typeof sourceName !== "string" || sourceName.length === 0) {
    return errorResponse("INVALID_INPUT", "sourceName 必填", 400);
  }
  if (sourceName.length > 200) {
    return errorResponse("INVALID_INPUT", "sourceName 长度不能超过 200", 400);
  }

  if (typeof body.sessionId === "string" && body.sessionId.length > 100) {
    return errorResponse("INVALID_INPUT", "sessionId 长度不能超过 100", 400);
  }
  if (typeof body.sessionName === "string" && body.sessionName.length > 200) {
    return errorResponse("INVALID_INPUT", "sessionName 长度不能超过 200", 400);
  }
  if (typeof body.semesterStart === "string" && body.semesterStart.length > 10) {
    return errorResponse("INVALID_INPUT", "semesterStart 长度不能超过 10", 400);
  }

  const sourceTypeTyped = sourceType as SourceType;
  const isExternal = EXTERNAL_SOURCE_TYPES.has(sourceTypeTyped);

  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.length > 0
      ? body.sessionId
      : null;
  const sessionName =
    typeof body.sessionName === "string" && body.sessionName.length > 0
      ? body.sessionName
      : null;
  const semesterStart =
    typeof body.semesterStart === "string" && body.semesterStart.length > 0
      ? body.semesterStart
      : null;
  // is_personal is DERIVED from the validated sourceType — never trusted from the
  // client. Sync/entitlement classify by sourceType, and the frontend relies on
  // is_personal for dedup/grouping/Sync All, so a client-supplied value (e.g.
  // instructor + isPersonal:true) would misclassify the subscription.
  const isPersonal = PERSONAL_SOURCE_TYPES.has(sourceTypeTyped);

  // ── Personal-subscription identity binding (security invariant) ───────────
  //  For personal source types, the personal schedule is fetched against the
  //  AUTHENTICATED bearer's own 学号 at sync time (see schedule-sync consumer);
  //  the stored sourceId never reaches the CQU API. We therefore IGNORE any
  //  client-supplied sourceId and pin it to the trusted auth `user.id` so it is
  //  a stable per-user identifier (uniqueness/ICS UID namespace) that cannot be
  //  abused to reference another student. External types keep the client
  //  sourceId — those are public timetables and the target id is meant to vary.
  //  (For external types the validation above guarantees a non-empty string;
  //  personal types pin to user.id so the client sourceId is never read.)
  const effectiveSourceId = PERSONAL_SOURCE_TYPES.has(sourceTypeTyped)
    ? user.id
    : (sourceId as string);

  // ── Entitlement gating ────────────────────────────────────────────────────
  try {
    if (isExternal) {
      // 外部课表软禁用(可逆):瑞数化后无法 harvest,拒绝新增外部订阅。在配额/写库
      // 之前短路,不暴露 WAF。个人订阅不受影响。
      const unavailable = externalUnavailableResponse();
      if (unavailable) return unavailable;
      assertFlag(caps, "external", "外部订阅");
    } else {
      assertFlag(caps, "sync", "日历同步");
    }

    // best-effort 配额：count-then-insert 存在 TOCTOU，并发下可能 +1 超配；无 DB 层兜底（软业务限制，可接受）
    const [countRow] = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id));
    assertQuota(caps, "sub_limit", countRow?.cnt ?? 0, "订阅数量");
  } catch (e) {
    return entitlementError(e);
  }

  // ── Duplicate check (uq_user_source_session) ──────────────────────────────
  const dupConds = [
    eq(subscriptions.userId, user.id),
    eq(subscriptions.sourceType, sourceTypeTyped),
    eq(subscriptions.sourceId, effectiveSourceId),
    sessionId === null
      ? sql`${subscriptions.sessionId} is null`
      : eq(subscriptions.sessionId, sessionId),
  ];
  const [dup] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(...dupConds))
    .limit(1);
  if (dup) {
    return errorResponse("ALREADY_EXISTS", "该订阅已存在", 409);
  }

  // ── Create subscription + default link atomically (D1 batch) ──────────────
  const subId = crypto.randomUUID();
  const token = await generateUniqueToken((t) => linkTokenExists(db, t));
  const linkId = crypto.randomUUID();
  const now = new Date().toISOString();
  const initialRunId = crypto.randomUUID();
  const formatsJson = JSON.stringify([...LINK_FORMATS]);

  try {
    await db.batch([
      db.insert(subscriptions).values({
        id: subId,
        userId: user.id,
        sourceType: sourceTypeTyped,
        sourceId: effectiveSourceId,
        sourceName,
        sessionId,
        sessionName,
        semesterStart,
        isPersonal,
        isActive: true,
        syncStatus: "queued",
        syncRunId: initialRunId,
        syncTrigger: "initial",
        syncRequestedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(calendarLinks).values({
        id: linkId,
        subscriptionId: subId,
        token,
        formats: formatsJson,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } catch (e) {
    // Unique-constraint races still land here even after the pre-check above.
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique|constraint/i.test(msg)) {
      return errorResponse("ALREADY_EXISTS", "该订阅已存在", 409);
    }
    throw e;
  }

  // Kick off an initial sync so the new subscription's links serve real data
  // promptly instead of EMPTY_ICS until the next hourly cron (deliveries spread
  // over 6h). Best-effort: the row is already committed, and the cron will pick
  // it up (lastSyncedAt is null → due) if this enqueue fails.
  await c.env.SCHEDULE_SYNC_QUEUE.send({
    subscriptionId: subId,
    userId: user.id,
    trigger: "initial",
    runId: initialRunId,
  } satisfies ScheduleSyncMessage).catch((e) =>
    markSyncError(db, subId, initialRunId, {
      code: "QUEUE_UNAVAILABLE",
      message: "同步服务暂时不可用，请稍后重试",
    }).then(() => console.warn(JSON.stringify({
      event: "subscription.v2.initial_sync_enqueue_failed",
      subscriptionId: subId,
      error: e instanceof Error ? e.message : String(e),
      message: "Failed to enqueue initial sync; cron will sync later",
    }))),
  );

  console.log(
    JSON.stringify({
      event: "subscription.v2.create",
      userId: user.id,
      subscriptionId: subId,
      sourceType: sourceTypeTyped,
      isExternal,
      message: "Subscription created with default link",
    }),
  );

  return c.json(
    {
      id: subId,
      user_id: user.id,
      source_type: sourceTypeTyped,
      source_id: effectiveSourceId,
      source_name: sourceName,
      session_id: sessionId,
      session_name: sessionName,
      semester_start: semesterStart,
      is_personal: isPersonal,
      last_synced_at: null,
      sync_status: "queued",
      sync_run_id: initialRunId,
      sync_trigger: "initial",
      sync_requested_at: now,
      sync_started_at: null,
      sync_finished_at: null,
      sync_error_code: null,
      sync_error_message: null,
      created_at: now,
      updated_at: now,
      links: [
        toLinkSummary({
          id: linkId,
          token,
          label: null,
          formats: formatsJson,
          isDefault: true,
        }),
      ],
    },
    201,
    { Location: `/api/v2/subscriptions/${subId}` },
  );
});

// ── DELETE /:sid — delete a subscription (FK cascade removes its links) ──────
app.delete("/:sid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, sid), eq(subscriptions.userId, user.id)))
    .limit(1);

  if (!sub) return errorResponse("NOT_FOUND", "订阅不存在", 404);

  await db.delete(subscriptions).where(eq(subscriptions.id, sub.id));

  console.log(
    JSON.stringify({
      event: "subscription.v2.delete",
      userId: user.id,
      subscriptionId: sub.id,
      message: "Subscription deleted (links cascaded)",
    }),
  );

  return c.body(null, 204);
});

// ── G3: POST /:sid/syncs — manual refresh (per-day manual_refresh quota) ──────
//  Verifies ownership → checks the daily refresh counter against caps →
//  enqueues a single-subscription sync → 202 Accepted. The KV counter
//  `refresh:<userId>:<china-date>` is incremented best-effort after enqueue.
app.post("/:sid/syncs", async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({
      id: subscriptions.id,
      sourceType: subscriptions.sourceType,
      isActive: subscriptions.isActive,
      manualRefreshAt: subscriptions.manualRefreshAt,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, sid), eq(subscriptions.userId, user.id)))
    .limit(1);
  if (!sub) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }

  // Entitlement / is_active reconcile — runs FULLY before the external soft-disable
  // 503 short-circuit below, so a frozen external sub's active/inactive state is
  // reconciled regardless of whether it gets serviced:
  //  - REVOKED (cap lost): flip inactive NOW so the public link stops serving,
  //    without waiting for the hourly producer (Codex round-3 REVOCATION GAP).
  //  - RE-ENTITLED (cap regained, was inactive): flip active NOW so the link
  //    resumes immediately, without waiting for the cron (Codex round-4
  //    REACTIVATION GAP). Both reconciles must precede the external 503: the
  //    freeze only suppresses ENQUEUE — it must not suppress is_active enforcement.
  const isPersonal = PERSONAL_SOURCE_TYPES.has(sub.sourceType);
  const revoked = isPersonal ? !caps.sync : !caps.external;
  if (revoked && sub.isActive) {
    await db
      .update(subscriptions)
      .set({ isActive: false, updatedAt: new Date().toISOString() })
      .where(eq(subscriptions.id, sid));
  } else if (!revoked && !sub.isActive) {
    await db
      .update(subscriptions)
      .set({ isActive: true, updatedAt: new Date().toISOString() })
      .where(eq(subscriptions.id, sid));
  }

  // 外部订阅软禁用:停止接受外部订阅的手动刷新(不入队、不消耗配额、不暴露 WAF)。
  // 已有数据保持冻结。个人订阅照常。放在 is_active 对账之后:被吊销 external 权益的
  // 外部订阅已被对账成 inactive、被重新授权的已对账成 active,然后才统一以"暂不可用"
  // 503 回应(不按权益区分响应,绝不暴露 WAF/瑞数细节)。
  if (EXTERNAL_SOURCE_TYPES.has(sub.sourceType)) {
    const unavailable = externalUnavailableResponse();
    if (unavailable) return unavailable;
  }

  // Personal sub with a revoked `sync` cap (external soft-disable did not短路):
  // reject with 403 (the external revoked case already returned 503 above when
  // soft-disabled; if external re-enables, a revoked external owner lands here too).
  if (revoked) {
    return errorResponse(
      "FEATURE_NOT_ENABLED",
      `${isPersonal ? "日历同步" : "外部订阅"}未开通`,
      403,
    );
  }

  // manual_refresh quota: null = unlimited, 0 = disabled, n = n/day.
  // best-effort 软配额：KV read-then-write 存在 TOCTOU，并发/多地请求可能各自读到
  // 低于上限就放行，导致轻微超额（与 sub_limit/share_limit 一致的软限制取舍）。
  // 这是防滥用的软门槛，单次超额代价有限（多几次上游同步）；如需严格保证再换
  // D1/Durable Object 原子计数。
  const limit = resolveQuota(caps.manual_refresh);
  const dayKey = chinaDateKey(new Date());
  const counterKey = `refresh:${user.id}:${dayKey}`;

  let used = 0;
  if (limit !== Infinity) {
    const raw = await c.env.CACHE.get(counterKey);
    used = raw ? Number(raw) || 0 : 0;
    if (used >= limit) {
      return errorResponse("RATE_LIMITED", "今日手动刷新次数已达上限", 429);
    }
  }

  // One personal harvest already returns both courses and exams, so the three
  // personal subscription views are one logical refresh group. External
  // subscriptions keep an independent per-subscription cooldown.
  const refreshTargets = isPersonal
    ? await db
        .select({ id: subscriptions.id, manualRefreshAt: subscriptions.manualRefreshAt })
        .from(subscriptions)
        .where(and(
          eq(subscriptions.userId, user.id),
          inArray(subscriptions.sourceType, [...PERSONAL_SOURCE_TYPES]),
        ))
    : [{ id: sub.id, manualRefreshAt: sub.manualRefreshAt }];
  const affectedSubscriptionIds = refreshTargets.map(target => target.id);
  const cooldownOwner = [...refreshTargets].sort((a, b) => a.id.localeCompare(b.id))[0];
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const cooldownUntil = new Date(nowDate.getTime() + MANUAL_REFRESH_COOLDOWN_MS).toISOString();
  const cooldownCutoff = new Date(nowDate.getTime() - MANUAL_REFRESH_COOLDOWN_MS).toISOString();

  const latestRefreshAt = refreshTargets.reduce<string | null>((latest, target) => {
    if (!target.manualRefreshAt) return latest;
    return !latest || target.manualRefreshAt > latest ? target.manualRefreshAt : latest;
  }, null);
  if (latestRefreshAt && latestRefreshAt > cooldownCutoff) {
    return manualRefreshCooldownResponse(latestRefreshAt, nowDate);
  }

  // The conditional update is the concurrency gate: simultaneous requests for
  // any member of the personal trio choose the same stable owner row, and only
  // one can advance its timestamp from an expired value.
  const claim = await db
    .update(subscriptions)
    .set({ manualRefreshAt: now })
    .where(and(
      eq(subscriptions.id, cooldownOwner.id),
      or(isNull(subscriptions.manualRefreshAt), lte(subscriptions.manualRefreshAt, cooldownCutoff)),
    ));
  if ((claim.meta?.changes ?? 0) === 0) {
    const [current] = await db
      .select({ manualRefreshAt: subscriptions.manualRefreshAt })
      .from(subscriptions)
      .where(eq(subscriptions.id, cooldownOwner.id))
      .limit(1);
    return manualRefreshCooldownResponse(current?.manualRefreshAt ?? now, nowDate);
  }

  await db
    .update(subscriptions)
    .set({ manualRefreshAt: now })
    .where(inArray(subscriptions.id, affectedSubscriptionIds));

  const runId = crypto.randomUUID();
  try {
    await queueSyncRuns(db, affectedSubscriptionIds, "manual", runId);
    await c.env.SCHEDULE_SYNC_QUEUE.send({
      subscriptionId: sid,
      userId: user.id,
      trigger: "manual",
      runId,
    } satisfies ScheduleSyncMessage);
  } catch (error) {
    await Promise.all(affectedSubscriptionIds.map(targetId => markSyncError(db, targetId, runId, {
      code: "QUEUE_UNAVAILABLE",
      message: "同步服务暂时不可用，请稍后重试",
    })));
    await db
      .update(subscriptions)
      .set({ manualRefreshAt: null })
      .where(and(
        inArray(subscriptions.id, affectedSubscriptionIds),
        eq(subscriptions.manualRefreshAt, now),
      ));
    throw error;
  }

  // Increment the daily counter (best-effort). TTL covers the rest of the day
  // plus a margin; an exact midnight rollover is not required for a soft quota.
  if (limit !== Infinity) {
    await c.env.CACHE.put(counterKey, String(used + 1), {
      expirationTtl: 60 * 60 * 25,
    }).catch(() => {});
  }

  console.log(
    JSON.stringify({
      event: "subscription.v2.manual_refresh",
      userId: user.id,
      subscriptionId: sid,
      message: "Manual refresh enqueued",
    }),
  );

  return c.json({
    status: "queued",
    run_id: runId,
    affected_subscription_ids: affectedSubscriptionIds,
    cooldown_until: cooldownUntil,
  }, 202);
});

function manualRefreshCooldownResponse(lastRefreshAt: string, now: Date): Response {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(lastRefreshAt) + MANUAL_REFRESH_COOLDOWN_MS - now.getTime()) / 1000),
  );
  return Response.json(
    {
      detail: {
        error: {
          code: "MANUAL_REFRESH_COOLDOWN",
          message: `请在 ${retryAfterSeconds} 秒后再次刷新`,
          retry_after_seconds: retryAfterSeconds,
        },
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** China-local date key (YYYY-MM-DD) for the per-day refresh counter. */
function chinaDateKey(now: Date): string {
  return new Date(now.getTime() + CHINA_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════════════
//  Calendar links (nested under /:sid/links) — guarded by sessionMiddleware via
//  the parent mount. Every handler first verifies the :sid subscription belongs
//  to the current user (404 otherwise).
// ════════════════════════════════════════════════════════════════════════════

/** Return the subscription if it belongs to `userId`, else undefined. */
async function ownedSubscription(db: ReturnType<typeof drizzle>, sid: string, userId: string) {
  const [sub] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, sid), eq(subscriptions.userId, userId)))
    .limit(1);
  return sub;
}

/** Return the link if it exists and belongs to the given subscription, else undefined. */
async function linkOfSubscription(
  db: ReturnType<typeof drizzle>,
  lid: string,
  sid: string,
) {
  const [link] = await db
    .select()
    .from(calendarLinks)
    .where(and(eq(calendarLinks.id, lid), eq(calendarLinks.subscriptionId, sid)))
    .limit(1);
  return link;
}

// ── E2: GET /:sid/links — list links for the subscription (default first) ─────
app.get("/:sid/links", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  if (!(await ownedSubscription(db, sid, user.id))) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }

  const links = await db
    .select()
    .from(calendarLinks)
    .where(eq(calendarLinks.subscriptionId, sid))
    .orderBy(desc(calendarLinks.isDefault), asc(calendarLinks.createdAt));

  return c.json({ links: links.map(toLinkSummary), count: links.length });
});

// ── E2: GET /:sid/links/:lid — single link ───────────────────────────────────
app.get("/:sid/links/:lid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const lid = c.req.param("lid");
  const db = drizzle(c.env.DB);

  if (!(await ownedSubscription(db, sid, user.id))) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  const link = await linkOfSubscription(db, lid, sid);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);

  return c.json(toLinkSummary(link));
});

// ── E3: POST /:sid/links — create a share link (caps.share + share_limit) ─────
app.post("/:sid/links", async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  if (!(await ownedSubscription(db, sid, user.id))) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("INVALID_INPUT", "无效的 JSON 请求体", 400);
  }

  // Optional label (≤ LABEL_MAX_LEN chars).
  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== "string") {
      return errorResponse("INVALID_INPUT", "label 必须为字符串", 400);
    }
    if (body.label.length > LABEL_MAX_LEN) {
      return errorResponse("INVALID_INPUT", `label 长度不能超过 ${LABEL_MAX_LEN}`, 400);
    }
    label = body.label.length > 0 ? body.label : null;
  }

  // Formats: validated subset of LINK_FORMATS.
  let formats: string[];
  try {
    formats = parseFormats(body.formats);
  } catch {
    return errorResponse("INVALID_FORMATS", "formats 无效", 400);
  }

  // Entitlement: share flag + per-user share_limit (across ALL subscriptions,
  // excluding default links).
  try {
    assertFlag(caps, "share", "共享链接");

    // best-effort 配额：count-then-insert 存在 TOCTOU，并发下可能 +1 超配；无 DB 层兜底（软业务限制，可接受）
    const [countRow] = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(calendarLinks)
      .innerJoin(subscriptions, eq(calendarLinks.subscriptionId, subscriptions.id))
      .where(and(eq(subscriptions.userId, user.id), eq(calendarLinks.isDefault, false)));
    assertQuota(caps, "share_limit", countRow?.cnt ?? 0, "共享链接");
  } catch (e) {
    return entitlementError(e);
  }

  const linkId = crypto.randomUUID();
  const token = await generateUniqueToken((t) => linkTokenExists(db, t));
  const now = new Date().toISOString();
  const formatsJson = JSON.stringify(formats);

  await db.insert(calendarLinks).values({
    id: linkId,
    subscriptionId: sid,
    token,
    label,
    formats: formatsJson,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  });

  console.log(
    JSON.stringify({
      event: "link.v2.create",
      userId: user.id,
      subscriptionId: sid,
      linkId,
      formats,
      message: "Share link created",
    }),
  );

  return c.json(
    toLinkSummary({ id: linkId, token, label, formats: formatsJson, isDefault: false }),
    201,
    { Location: `/api/v2/subscriptions/${sid}/links/${linkId}` },
  );
});

// ── E4: PATCH /:sid/links/:lid — update label/formats (default immutable) ─────
app.patch("/:sid/links/:lid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const lid = c.req.param("lid");
  const db = drizzle(c.env.DB);

  if (!(await ownedSubscription(db, sid, user.id))) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  const link = await linkOfSubscription(db, lid, sid);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);
  if (link.isDefault) {
    return errorResponse("DEFAULT_LINK_IMMUTABLE", "默认链接不可修改", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("INVALID_INPUT", "无效的 JSON 请求体", 400);
  }

  const updates: Partial<typeof calendarLinks.$inferInsert> = {};

  if (body.label !== undefined) {
    if (body.label === null) {
      updates.label = null;
    } else if (typeof body.label !== "string") {
      return errorResponse("INVALID_INPUT", "label 必须为字符串", 400);
    } else if (body.label.length > LABEL_MAX_LEN) {
      return errorResponse("INVALID_INPUT", `label 长度不能超过 ${LABEL_MAX_LEN}`, 400);
    } else {
      updates.label = body.label.length > 0 ? body.label : null;
    }
  }

  if (body.formats !== undefined) {
    let formats: string[];
    try {
      formats = parseFormats(body.formats);
    } catch {
      return errorResponse("INVALID_FORMATS", "formats 无效", 400);
    }
    updates.formats = JSON.stringify(formats);
  }

  updates.updatedAt = new Date().toISOString();

  await db.update(calendarLinks).set(updates).where(eq(calendarLinks.id, lid));

  console.log(
    JSON.stringify({
      event: "link.v2.patch",
      userId: user.id,
      subscriptionId: sid,
      linkId: lid,
      message: "Share link updated",
    }),
  );

  return c.json(
    toLinkSummary({
      id: link.id,
      token: link.token,
      label: updates.label !== undefined ? (updates.label ?? null) : link.label,
      formats: updates.formats ?? link.formats,
      isDefault: link.isDefault,
    }),
  );
});

// ── E5: DELETE /:sid/links/:lid — delete a share link (default immutable) ─────
app.delete("/:sid/links/:lid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const lid = c.req.param("lid");
  const db = drizzle(c.env.DB);

  if (!(await ownedSubscription(db, sid, user.id))) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  const link = await linkOfSubscription(db, lid, sid);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);
  if (link.isDefault) {
    return errorResponse("DEFAULT_LINK_IMMUTABLE", "默认链接不可删除", 403);
  }

  await db.delete(calendarLinks).where(eq(calendarLinks.id, lid));

  console.log(
    JSON.stringify({
      event: "link.v2.delete",
      userId: user.id,
      subscriptionId: sid,
      linkId: lid,
      message: "Share link deleted",
    }),
  );

  return c.body(null, 204);
});

// ── E6: POST /:sid/links/:lid/rotations — rotate token (default allowed) ──────
app.post("/:sid/links/:lid/rotations", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const lid = c.req.param("lid");
  const db = drizzle(c.env.DB);

  if (!(await ownedSubscription(db, sid, user.id))) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  const link = await linkOfSubscription(db, lid, sid);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);

  const token = await generateUniqueToken((t) => linkTokenExists(db, t));
  const now = new Date().toISOString();

  await db
    .update(calendarLinks)
    .set({ token, updatedAt: now })
    .where(eq(calendarLinks.id, lid));

  console.log(
    JSON.stringify({
      event: "link.v2.rotate",
      userId: user.id,
      subscriptionId: sid,
      linkId: lid,
      message: "Link token rotated",
    }),
  );

  const responseBody: { token: string; url?: string } = { token };
  const url = buildCalendarUrl(c.env.PUBLIC_URL, token);
  if (url) {
    responseBody.url = url;
  }

  return c.json(responseBody, 201);
});

/** Serialize a subscription row into the public snake_case shape (sans links). */
function serializeSubscription(sub: typeof subscriptions.$inferSelect) {
  return {
    id: sub.id,
    user_id: sub.userId,
    source_type: sub.sourceType,
    source_id: sub.sourceId,
    source_name: sub.sourceName,
    session_id: sub.sessionId,
    session_name: sub.sessionName,
    semester_start: sub.semesterStart,
    is_personal: sub.isPersonal,
    last_synced_at: sub.lastSyncedAt,
    sync_status: sub.syncStatus,
    sync_run_id: sub.syncRunId,
    sync_trigger: sub.syncTrigger,
    sync_requested_at: sub.syncRequestedAt,
    sync_started_at: sub.syncStartedAt,
    sync_finished_at: sub.syncFinishedAt,
    sync_error_code: sub.syncErrorCode,
    sync_error_message: sub.syncErrorMessage,
    manual_refresh_at: sub.manualRefreshAt,
    created_at: sub.createdAt,
    updated_at: sub.updatedAt,
  };
}

export default app;
