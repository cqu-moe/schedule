import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc, asc, sql, inArray, isNull, lte, ne, or } from "drizzle-orm";
import {
  subscriptions,
  calendarLinks,
  LINK_FORMATS,
  SOURCE_TYPES,
  EXTERNAL_SOURCE_TYPES,
  PERSONAL_SOURCE_TYPES,
  type SourceType,
  type PersonalSubscriptionView,
  type PersonalViewType,
} from "../../db/schema";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, assertQuota, EntitlementError } from "../../middleware/entitlements";
import { resolveQuota } from "../../services/auth-rpc";
import { errorResponse } from "../../utils/error";
import { reselectExternalCourse } from "../../services/external-reselection";
import { createExternalSubscription } from "../../services/external-subscriptions";
import {
  ExternalManualRefreshCooldownError,
  getExternalManualRemaining,
  requestExternalManualSync,
} from "../../services/external-manual-sync";
import { externalUnavailableResponse } from "../../config/external-availability";
import { generateUniqueToken, linkTokenExists } from "../../utils/token";
import { parseFormats, buildCalendarUrl } from "../../services/links";
import { CHINA_TZ_OFFSET_MS } from "../../utils/time";
import type { ScheduleSyncMessage } from "../../cron/schedule-sync";
import { markSyncError, queueSyncRuns } from "../../services/sync-status";
import {
  getPersonalSetup,
  prepareDefaultSubscriptions,
  summarizePersonalSetup,
  type DefaultSubscriptionsResponse,
} from "../../services/personal-subscription-setup";
import { dispatchPersonalSetup } from "../../services/personal-setup-dispatch";
import {
  listPersonalViews,
  resolveOwnedSubscription,
} from "../../services/personal-subscription-views";
import { personalSubscriptionMode } from "../../config/personal-subscription-mode";
import {
  ManualRefreshCooldownError,
  requestPersonalSync,
} from "../../services/personal-subscription-sync";
import { clearHarvestCache } from "../../services/cqu-harvest";
import { captureScheduleEvent } from "../../lib/posthog";
import {
  captureScheduleSyncStarted,
  captureScheduleSyncTerminal,
} from "../../lib/sync-telemetry";

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
  isActive: boolean;
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
    is_active: link.isActive,
  };
}

/** Map an EntitlementError to a JSON error response; rethrow anything else. */
function entitlementError(e: unknown): Response {
  if (e instanceof EntitlementError) {
    return errorResponse(e.code, e.message, e.status);
  }
  throw e;
}

type SubscriptionOperation =
  | "create"
  | "prepare_defaults"
  | "delete"
  | "create_link"
  | "update_link"
  | "delete_link"
  | "rotate_link";

function subscriptionOperation(method: string, mountedPath: string): SubscriptionOperation | null {
  if (method === "POST" && mountedPath === "/") return "create";
  if (method === "POST" && mountedPath === "/defaults") return "prepare_defaults";
  if (method === "DELETE" && /^\/[^/]+$/.test(mountedPath)) return "delete";
  if (method === "POST" && /^\/[^/]+\/links$/.test(mountedPath)) return "create_link";
  if (method === "PATCH" && /^\/[^/]+\/links\/[^/]+$/.test(mountedPath)) return "update_link";
  if (method === "DELETE" && /^\/[^/]+\/links\/[^/]+$/.test(mountedPath)) return "delete_link";
  if (method === "POST" && /^\/[^/]+\/links\/[^/]+\/rotations$/.test(mountedPath)) {
    return "rotate_link";
  }
  return null;
}

// The HTTP response is the authoritative user-facing terminal for subscription
// mutations; sync requests are excluded because the queue owns their terminal.
app.use("*", async (c, next) => {
  await next();
  const mountedPath = c.req.path.replace(/^\/api\/v2\/subscriptions?/, "") || "/";
  const operation = subscriptionOperation(c.req.method, mountedPath);
  if (!operation) return;

  const status = c.res.status;
  const outcome = status < 400
    ? "success"
    : [401, 403, 409].includes(status)
      ? "needs_input"
      : "failure";
  const user = c.get("user");
  const pathSubscriptionId = /^\/([^/]+)(?:\/|$)/.exec(mountedPath)?.[1];
  captureScheduleEvent(
    c.env,
    executionContext(c),
    "schedule_subscription_finished",
    user?.id ?? crypto.randomUUID(),
    {
      actor_type: user ? "user" : "system",
      trigger: "user",
      operation,
      outcome,
      ...(pathSubscriptionId && operation !== "prepare_defaults"
        ? { subscription_id: pathSubscriptionId }
        : {}),
    },
    Boolean(user),
  );
});

// ── GET / — list the current user's subscriptions (with link summaries) ──────
app.get("/", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const mode = personalSubscriptionMode(c.env);

  if (mode === "enabled") {
    try {
      const prepared = await prepareDefaultSubscriptions(
        c.env,
        user.id,
        c.get("caps").calendar,
        c.get("cquBindStatus"),
      );
      if (prepared.status === "created" || prepared.status === "resumed") {
        await dispatchPersonalSetup(c.env, user.id, executionContext(c)).catch((error) => {
          console.error(JSON.stringify({
            event: "subscription.list.dispatch_failed",
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      }
    } catch (error) {
      if (error instanceof EntitlementError) return entitlementError(error);
      console.error(JSON.stringify({
        event: "subscription.list.prepare_failed",
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      }));
      return errorResponse("DEFAULT_SUBSCRIPTIONS_FAILED", "订阅准备未完成，请重试。", 503);
    }
  }

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
      const scope = row.calendar_links.personalViewType ?? "";
      const key = `${row.calendar_links.subscriptionId}:${scope}`;
      const list = linksBySub.get(key) ?? [];
      list.push(toLinkSummary(row.calendar_links));
      linksBySub.set(key, list);
    }
  }

  const serialized = [];
  for (const sub of subs) {
    if (sub.sourceType === "personal") {
      const views = await listPersonalViews(c.env.DB, sub.id);
      for (const view of views) {
        serialized.push({
          ...serializePersonalView(sub, view),
          links: linksBySub.get(`${sub.id}:${view.sourceType}`) ?? [],
        });
      }
      continue;
    }
    serialized.push({
      ...serializeSubscription(sub),
      links: linksBySub.get(`${sub.id}:`) ?? [],
    });
  }

  const setup = await getPersonalSetup(c.env.DB, user.id);
  const manualRemaining = await getExternalManualRemaining(
    c.env,
    user.id,
    c.get("caps").calendar,
  );
  c.header("Cache-Control", "private, no-store");
  return c.json({
    subscriptions: serialized,
    count: serialized.length,
    quota_count: subs.filter(sub => sub.sourceVersion === 1).length,
    personal_setup: setup ? summarizePersonalSetup(setup) : null,
    manual_remaining: manualRemaining,
  });
});

// ── POST /defaults — initialize the fixed personal trio for this session ───
app.post("/defaults", async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;
  const mode = personalSubscriptionMode(c.env);

  if (mode === "migration") {
    return errorResponse(
      "PERSONAL_SUBSCRIPTION_MIGRATING",
      "个人课表正在维护，请稍后重试",
      503,
    );
  }

  if (!caps.sync) {
    return c.json({
      status: "skipped",
      subscription_ids: [],
      run_id: null,
      dispatch_status: "none",
    } satisfies DefaultSubscriptionsResponse);
  }

  const cquBindStatus = c.get("cquBindStatus");
  if (mode === "legacy" && cquBindStatus === undefined) {
    return errorResponse(
      "CQU_BINDING_STATUS_UNKNOWN",
      "暂时无法确认统一认证绑定状态",
      503,
    );
  }
  if (mode === "legacy" && cquBindStatus !== "active") {
    return errorResponse(
      "CQU_BINDING_REQUIRED",
      "请先绑定重庆大学统一认证账号",
      409,
    );
  }

  let result: DefaultSubscriptionsResponse;
  try {
    result = await prepareDefaultSubscriptions(c.env, user.id, caps, cquBindStatus);
  } catch (error) {
    if (error instanceof EntitlementError) return entitlementError(error);
    console.error(JSON.stringify({
      event: "subscription.defaults.prepare_failed",
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      message: "Failed to prepare default personal subscriptions",
    }));
    return errorResponse(
      "DEFAULT_SUBSCRIPTIONS_FAILED",
      "订阅准备未完成，请重试。",
      503,
    );
  }

  if (result.status === "created" || result.status === "resumed") {
    try {
      await dispatchPersonalSetup(c.env, user.id, executionContext(c));
    } catch (error) {
      console.error(JSON.stringify({
        event: "subscription.defaults.dispatch_failed",
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
        message: "Default subscriptions created but initial dispatch failed",
      }));
    }

    try {
      const setup = await getPersonalSetup(c.env.DB, user.id);
      if (!setup) throw new Error("PERSONAL_SETUP_WRITE_FAILED");
      const latest = summarizePersonalSetup(setup);
      result = {
        status: result.status,
        subscription_ids: latest.subscription_ids,
        run_id: latest.run_id,
        dispatch_status: latest.dispatch_status,
      };
    } catch (error) {
      console.error(JSON.stringify({
        event: "subscription.defaults.readback_failed",
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
        message: "Failed to read default subscription setup after dispatch",
      }));
      return errorResponse(
        "DEFAULT_SUBSCRIPTIONS_FAILED",
        "订阅准备未完成，请重试。",
        503,
      );
    }
  }

  return c.json(result, result.status === "created" ? 201 : 200);
});

// ── GET /:sid — single subscription (404 if not owned by current user) ───────
app.get("/:sid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);
  const resolved = await resolveOwnedSubscription(c.env.DB, user.id, sid);
  if (!resolved) return errorResponse("NOT_FOUND", "订阅不存在", 404);

  const sub = resolved.subscription;
  let view = resolved.view;
  if (sub.sourceType === "personal" && !view) {
    view = (await listPersonalViews(c.env.DB, sub.id))
      .find((candidate) => candidate.sourceType === "personal_all") ?? null;
    if (!view) return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }

  const links = await db
    .select()
    .from(calendarLinks)
    .where(view
      ? and(
          eq(calendarLinks.subscriptionId, sub.id),
          eq(calendarLinks.personalViewType, view.sourceType),
        )
      : eq(calendarLinks.subscriptionId, sub.id))
    .orderBy(desc(calendarLinks.isDefault), asc(calendarLinks.createdAt));

  return c.json({
    ...(view ? serializePersonalView(sub, view) : serializeSubscription(sub)),
    links: links.map(toLinkSummary),
  });
});

app.post("/:sid/target-selection", async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return errorResponse("INVALID_INPUT", "无效的 JSON 请求体", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("INVALID_INPUT", "请求体必须为对象", 400);
  try {
    return c.json(await reselectExternalCourse(c.env, c.get("user").id, c.req.param("sid"), c.get("caps").calendar, c.get("cquBindStatus"), body, executionContext(c)), 202);
  } catch (error) { return entitlementError(error); }
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
  if (PERSONAL_SOURCE_TYPES.has(sourceType as SourceType)) {
    if (personalSubscriptionMode(c.env) === "migration") {
      return errorResponse(
        "PERSONAL_SUBSCRIPTION_MIGRATING",
        "个人课表正在维护，请稍后重试",
        503,
      );
    }
    return errorResponse(
      "PERSONAL_SUBSCRIPTION_MANAGED",
      "个人课表由系统自动提供，无需手动添加",
      403,
    );
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

  try {
    const created = await createExternalSubscription(c.env, user.id, caps, c.get("cquBindStatus"), body, executionContext(c));
    return c.json({ ...serializeSubscription(created.subscription), links: [toLinkSummary(created.link)] }, 201,
      { Location: `/api/v2/subscriptions/${created.subscription.id}` });
  } catch (error) { return entitlementError(error); }
});

// ── DELETE /:sid — delete a subscription (FK cascade removes its links) ──────
app.delete("/:sid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const resolved = await resolveOwnedSubscription(c.env.DB, user.id, sid);
  if (!resolved) return errorResponse("NOT_FOUND", "订阅不存在", 404);
  const sub = resolved.subscription;
  if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
    if (personalSubscriptionMode(c.env) === "migration") {
      return errorResponse(
        "PERSONAL_SUBSCRIPTION_MIGRATING",
        "个人课表正在维护，请稍后重试",
        503,
      );
    }
    return errorResponse(
      "PERSONAL_SUBSCRIPTION_MANAGED",
      "个人课表由系统自动提供，无法删除",
      403,
    );
  }

  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO personal_subscription_setup
      (user_id,status,subscription_ids,dispatch_status,created_at,updated_at)
      VALUES (?,'existing','[]','sent',?,?) ON CONFLICT(user_id) DO NOTHING`)
      .bind(user.id, now, now),
    c.env.DB.prepare("DELETE FROM subscriptions WHERE id=? AND user_id=?")
      .bind(sub.id, user.id),
  ]);
  // The per-user harvest cache (KV, 10 min TTL) outlives the subscription unless
  // cleared here — best-effort, the delete above already succeeded (issue #97).
  await clearHarvestCache(c.env, user.id);

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
app.post("/personal/syncs", async (c) => {
  const user = c.get("user");
  try {
    const result = await requestPersonalSync(
      c.env,
      user.id,
      c.get("caps").calendar,
      c.get("cquBindStatus"),
      executionContext(c),
    );
    return c.json(result, 202);
  } catch (error) {
    if (error instanceof ManualRefreshCooldownError) {
      return manualRefreshCooldownResponse(error.manualRefreshAt, new Date());
    }
    if (error instanceof EntitlementError) return entitlementError(error);
    throw error;
  }
});

app.post("/:sid/syncs", async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const resolved = await resolveOwnedSubscription(c.env.DB, user.id, sid);
  if (!resolved) return errorResponse("NOT_FOUND", "订阅不存在", 404);
  if (resolved.subscription.sourceVersion === 1 && resolved.subscription.externalState !== "active") {
    return errorResponse(resolved.subscription.externalState === "expired" ? "EXTERNAL_TERM_EXPIRED" : "EXTERNAL_RESELECTING",
      resolved.subscription.externalState === "expired" ? "教学班所属学期已结束，全部公开链接已停用" : "正在重新选择教学班，请等待新课表同步完成", 409);
  }

  if (
    personalSubscriptionMode(c.env) === "migration"
    && PERSONAL_SOURCE_TYPES.has(resolved.subscription.sourceType)
  ) {
    return errorResponse(
      "PERSONAL_SUBSCRIPTION_MIGRATING",
      "个人课表正在维护，请稍后重试",
      503,
    );
  }
  if (resolved.subscription.sourceType === "personal") {
    try {
      const result = await requestPersonalSync(
        c.env,
        user.id,
        caps,
        c.get("cquBindStatus"),
        executionContext(c),
      );
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof ManualRefreshCooldownError) {
        return manualRefreshCooldownResponse(error.manualRefreshAt, new Date());
      }
      if (error instanceof EntitlementError) return entitlementError(error);
      throw error;
    }
  }

  const [sub] = await db
    .select({
      id: subscriptions.id,
      sourceType: subscriptions.sourceType,
      sourceVersion: subscriptions.sourceVersion,
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
  //    without waiting for the cron producer (Codex round-3 REVOCATION GAP).
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

  // Share-cap link reconcile (issue #89): follow the CONFIRMED caps.share for
  // this subscription's non-default links — revoked stops them serving (public
  // 403 LINK_INACTIVE), re-granted resumes them. Mirrors the is_active reconcile
  // above (runs before any 403/503 short-circuit); default links are the
  // subscription's own delivery channel and stay governed by isActive.
  await db
    .update(calendarLinks)
    .set({ isActive: caps.share, updatedAt: new Date().toISOString() })
    .where(and(
      eq(calendarLinks.subscriptionId, sid),
      eq(calendarLinks.isDefault, false),
      ne(calendarLinks.isActive, caps.share),
    ));

  // 外部订阅软禁用:停止接受外部订阅的手动刷新(不入队、不消耗配额、不暴露 WAF)。
  // 已有数据保持冻结。个人订阅照常。放在 is_active 对账之后:被吊销 external 权益的
  // 外部订阅已被对账成 inactive、被重新授权的已对账成 active,然后才统一以"暂不可用"
  // 503 回应(不按权益区分响应,绝不暴露 WAF/瑞数细节)。
  if (EXTERNAL_SOURCE_TYPES.has(sub.sourceType) && sub.sourceVersion === 1) {
    try {
      const result = await requestExternalManualSync(
        c.env,
        user.id,
        caps,
        c.get("cquBindStatus"),
        sid,
        executionContext(c),
      );
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof ExternalManualRefreshCooldownError) {
        return manualRefreshCooldownResponse(error.manualRefreshAt, new Date());
      }
      if (error instanceof EntitlementError) return entitlementError(error);
      throw error;
    }
  }

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
    captureScheduleSyncStarted(c.env, executionContext(c), {
      userId: user.id,
      subscriptionId: sid,
      runId,
      trigger: "manual",
    });
  } catch (error) {
    const terminals = await Promise.all(affectedSubscriptionIds.map(targetId => markSyncError(db, targetId, runId, {
      code: "QUEUE_UNAVAILABLE",
      message: "同步服务暂时不可用，请稍后重试",
    })));
    affectedSubscriptionIds.forEach((targetId, index) => {
      if (!terminals[index]) return;
      captureScheduleSyncTerminal(c.env, executionContext(c), {
        userId: user.id,
        subscriptionId: targetId,
        runId,
        trigger: "manual",
        requestedAt: Date.parse(now),
      }, "failure", "QUEUE_UNAVAILABLE");
    });
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

interface OwnedSubscriptionScope {
  id: string;
  viewType: PersonalViewType | null;
  isPersonal: boolean;
}

/** Resolve either a real subscription id or a compatibility view id. */
async function ownedSubscription(
  database: D1Database,
  sid: string,
  userId: string,
): Promise<OwnedSubscriptionScope | null> {
  const resolved = await resolveOwnedSubscription(database, userId, sid);
  if (!resolved) return null;
  let viewType = resolved.view?.sourceType ?? null;
  if (resolved.subscription.sourceType === "personal" && !viewType) {
    viewType = (await listPersonalViews(database, resolved.subscription.id))
      .find((view) => view.sourceType === "personal_all")?.sourceType ?? null;
  }
  return {
    id: resolved.subscription.id,
    viewType,
    isPersonal: PERSONAL_SOURCE_TYPES.has(resolved.subscription.sourceType),
  };
}

/** Return the link if it exists and belongs to the given subscription, else undefined. */
async function linkOfSubscription(
  db: ReturnType<typeof drizzle>,
  lid: string,
  owner: OwnedSubscriptionScope,
) {
  const scope = owner.viewType
    ? eq(calendarLinks.personalViewType, owner.viewType)
    : isNull(calendarLinks.personalViewType);
  const [link] = await db
    .select()
    .from(calendarLinks)
    .where(and(
      eq(calendarLinks.id, lid),
      eq(calendarLinks.subscriptionId, owner.id),
      scope,
    ))
    .limit(1);
  return link;
}

// ── E2: GET /:sid/links — list links for the subscription (default first) ─────
app.get("/:sid/links", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const owner = await ownedSubscription(c.env.DB, sid, user.id);
  if (!owner) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }

  const links = await db
    .select()
    .from(calendarLinks)
    .where(and(
      eq(calendarLinks.subscriptionId, owner.id),
      owner.viewType
        ? eq(calendarLinks.personalViewType, owner.viewType)
        : isNull(calendarLinks.personalViewType),
    ))
    .orderBy(desc(calendarLinks.isDefault), asc(calendarLinks.createdAt));

  return c.json({ links: links.map(toLinkSummary), count: links.length });
});

// ── E2: GET /:sid/links/:lid — single link ───────────────────────────────────
app.get("/:sid/links/:lid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const lid = c.req.param("lid");
  const db = drizzle(c.env.DB);

  const owner = await ownedSubscription(c.env.DB, sid, user.id);
  if (!owner) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  const link = await linkOfSubscription(db, lid, owner);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);

  return c.json(toLinkSummary(link));
});

// ── E3: POST /:sid/links — create a share link (caps.share + share_limit) ─────
app.post("/:sid/links", async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;
  const sid = c.req.param("sid");
  const db = drizzle(c.env.DB);

  const owner = await ownedSubscription(c.env.DB, sid, user.id);
  if (!owner) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  if (owner.isPersonal && personalSubscriptionMode(c.env) === "migration") {
    return errorResponse("PERSONAL_SUBSCRIPTION_MIGRATING", "个人课表正在维护，请稍后重试", 503);
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

  await c.env.DB.prepare(`INSERT INTO calendar_links
    (id,subscription_id,token,label,formats,personal_view_type,is_default,is_active,created_at,updated_at)
    SELECT ?,id,?,?,?,?,0,CASE WHEN source_version=1 AND external_state<>'active' THEN 0 ELSE 1 END,?,?
    FROM subscriptions WHERE id=? AND user_id=?`)
    .bind(linkId, token, label, formatsJson, owner.viewType, now, now, owner.id, user.id).run();
  const [createdLink] = await db.select().from(calendarLinks).where(eq(calendarLinks.id, linkId));
  if (!createdLink) return errorResponse("NOT_FOUND", "订阅不存在", 404);

  console.log(
    JSON.stringify({
      event: "link.v2.create",
      userId: user.id,
      subscriptionId: owner.id,
      linkId,
      formats,
      message: "Share link created",
    }),
  );

  return c.json(
    toLinkSummary({
      id: linkId,
      token,
      label,
      formats: formatsJson,
      isDefault: false,
      isActive: createdLink.isActive,
    }),
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

  const owner = await ownedSubscription(c.env.DB, sid, user.id);
  if (!owner) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  if (owner.isPersonal && personalSubscriptionMode(c.env) === "migration") {
    return errorResponse("PERSONAL_SUBSCRIPTION_MIGRATING", "个人课表正在维护，请稍后重试", 503);
  }
  const link = await linkOfSubscription(db, lid, owner);
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
      isActive: link.isActive,
    }),
  );
});

// ── E5: DELETE /:sid/links/:lid — delete a share link (default immutable) ─────
app.delete("/:sid/links/:lid", async (c) => {
  const user = c.get("user");
  const sid = c.req.param("sid");
  const lid = c.req.param("lid");
  const db = drizzle(c.env.DB);

  const owner = await ownedSubscription(c.env.DB, sid, user.id);
  if (!owner) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  if (owner.isPersonal && personalSubscriptionMode(c.env) === "migration") {
    return errorResponse("PERSONAL_SUBSCRIPTION_MIGRATING", "个人课表正在维护，请稍后重试", 503);
  }
  const link = await linkOfSubscription(db, lid, owner);
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

  const owner = await ownedSubscription(c.env.DB, sid, user.id);
  if (!owner) {
    return errorResponse("NOT_FOUND", "订阅不存在", 404);
  }
  if (owner.isPersonal && personalSubscriptionMode(c.env) === "migration") {
    return errorResponse("PERSONAL_SUBSCRIPTION_MIGRATING", "个人课表正在维护，请稍后重试", 503);
  }
  const link = await linkOfSubscription(db, lid, owner);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);

  const token = await generateUniqueToken((t) => linkTokenExists(db, t));
  const now = new Date().toISOString();

  // Optimistic lock on the read-time token: concurrent rotations of the same
  // link must not both "succeed" while only the last UPDATE lands.
  const rotated = await db
    .update(calendarLinks)
    .set({ token, updatedAt: now })
    .where(and(eq(calendarLinks.id, lid), eq(calendarLinks.token, link.token)));
  if ((rotated.meta?.changes ?? 0) === 0) {
    return errorResponse("LINK_TOKEN_CONFLICT", "Token 刚被其他请求轮换，请重试", 409);
  }

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
    source_version: sub.sourceVersion,
    external_state: sub.externalState,
    import_quality: sub.importQuality,
    skipped_count: sub.skippedCount,
    source_id: sub.sourceId,
    source_name: sub.sourceName,
    session_id: sub.sessionId,
    session_name: sub.sessionName,
    semester_start: sub.semesterStart,
    is_personal: sub.isPersonal,
    is_active: sub.isActive,
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

function serializePersonalView(
  sub: typeof subscriptions.$inferSelect,
  view: PersonalSubscriptionView,
) {
  return {
    ...serializeSubscription(sub),
    id: view.id,
    source_type: view.sourceType,
    source_name: view.sourceName,
    created_at: view.createdAt,
  };
}

export default app;
function executionContext(c: { executionCtx: ExecutionContext }): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
