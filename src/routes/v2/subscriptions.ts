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
import { parseFormats, buildCalendarUrl } from "../../services/links";

const app = new Hono<SessionEnv>();

/** Max length for a user-supplied link label. */
const LABEL_MAX_LEN = 100;

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
    created_at: sub.createdAt,
    updated_at: sub.updatedAt,
  };
}

export default app;
