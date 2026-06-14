import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import {
  subscriptions,
  calendarLinks,
  LINK_FORMATS,
  SOURCE_TYPES,
  EXPLORE_SOURCE_TYPES,
  type SourceType,
} from "../../db/schema";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, assertQuota, EntitlementError } from "../../middleware/entitlements";
import { errorResponse } from "../../utils/error";
import { generateUniqueToken, linkTokenExists } from "../../utils/token";

const app = new Hono<SessionEnv>();

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
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    return errorResponse("INVALID_INPUT", "sourceId 必填", 400);
  }
  if (typeof sourceName !== "string" || sourceName.length === 0) {
    return errorResponse("INVALID_INPUT", "sourceName 必填", 400);
  }
  if (sourceId.length > 100) {
    return errorResponse("INVALID_INPUT", "sourceId 长度不能超过 100", 400);
  }
  if (sourceName.length > 200) {
    return errorResponse("INVALID_INPUT", "sourceName 长度不能超过 200", 400);
  }

  const sourceTypeTyped = sourceType as SourceType;
  const isExternal = EXPLORE_SOURCE_TYPES.has(sourceTypeTyped);

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
  const isPersonal =
    typeof body.isPersonal === "boolean" ? body.isPersonal : !isExternal;

  // ── Entitlement gating ────────────────────────────────────────────────────
  try {
    if (isExternal) {
      assertFlag(caps, "external", "外部订阅");
    } else {
      assertFlag(caps, "sync", "日历同步");
    }

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
    eq(subscriptions.sourceId, sourceId),
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
  const formatsJson = JSON.stringify([...LINK_FORMATS]);

  try {
    await db.batch([
      db.insert(subscriptions).values({
        id: subId,
        userId: user.id,
        sourceType: sourceTypeTyped,
        sourceId,
        sourceName,
        sessionId,
        sessionName,
        semesterStart,
        isPersonal,
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
      source_id: sourceId,
      source_name: sourceName,
      session_id: sessionId,
      session_name: sessionName,
      semester_start: semesterStart,
      is_personal: isPersonal,
      last_synced_at: null,
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
    created_at: sub.createdAt,
    updated_at: sub.updatedAt,
  };
}

export default app;
