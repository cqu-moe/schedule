import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { subscriptions, type Subscription, PERSONAL_SOURCE_TYPES, EXPLORE_SOURCE_TYPES, type SourceType, type ExploreSourceType } from "../db/schema";
import type { Env } from "../types";
import { requireAuth, requireAuthWithCquToken, type LightUser, type AuthUser } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { verifyCaptcha, CaptchaError } from "../services/captcha";
import { CQUAPIClient, type CourseEntry, type ExamEntry } from "../services/cqu-api";
import {
  semesterShortName,
  generateFormattedEvents,
  generateCsv,
} from "../services/export";
import { decrypt } from "../services/crypto";
import { EMPTY_ICS } from "../services/ics";
import { generateToken } from "../utils/token";
import { handleCquApiError, errorResponse } from "../utils/error";
import {
  fetchSessionContextCached,
  fetchPersonalScheduleCached,
  buildPersonalSyncResult,
  buildExploreSyncResult,
  applySyncResult,
  preGenerateIcs,
} from "../services/sync";

type AuthEnv = { Bindings: Env; Variables: { user: LightUser } };

const app = new Hono<AuthEnv>();

// GET /api/v1/subscriptions
app.get("/", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const baseUrl = (c.env.PUBLIC_URL ?? "").replace(/\/$/, "");

  const subs = await db
    .select({
      calendarToken: subscriptions.calendarToken,
      sourceType: subscriptions.sourceType,
      sourceId: subscriptions.sourceId,
      sourceName: subscriptions.sourceName,
      sessionId: subscriptions.sessionId,
      sessionName: subscriptions.sessionName,
      isPersonal: subscriptions.isPersonal,
      lastSyncedAt: subscriptions.lastSyncedAt,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .orderBy(desc(subscriptions.isPersonal), asc(subscriptions.createdAt));

  const response = c.json({
    subscriptions: subs.map((sub) => ({
      calendar_token: sub.calendarToken,
      subscription_url: `${baseUrl}/api/v1/subscriptions/${sub.calendarToken}/calendar.ics`,
      source_type: sub.sourceType,
      source_id: sub.sourceId,
      source_name: sub.sourceName,
      session_id: sub.sessionId,
      session_name: sub.sessionName,
      is_personal: sub.isPersonal,
      last_synced_at: sub.lastSyncedAt,
      created_at: sub.createdAt,
    })),
    count: subs.length,
    max: Number(c.env.MAX_SUBSCRIPTIONS ?? "10"),
  });
  response.headers.set("Cache-Control", "private, max-age=10");
  return response;
});

// POST /api/v1/subscriptions
app.post("/", requireAuthWithCquToken, rateLimit("EXPLORE_LIMITER"), async (c) => {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
  } catch (e) {
    if (e instanceof CaptchaError) return errorResponse(e.message, e.message, 403);
    throw e;
  }

  let body: { source_type: string; source_id: string; source_name: string };
  try {
    body = await c.req.json();
  } catch {
    return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
  }
  if (!body.source_id || !body.source_name) {
    return errorResponse("BAD_REQUEST", "source_id and source_name required", 400);
  }
  if (body.source_id.length > 100) {
    return errorResponse("BAD_REQUEST", "source_id must not exceed 100 characters", 400);
  }
  if (body.source_name.length > 200) {
    return errorResponse("BAD_REQUEST", "source_name must not exceed 200 characters", 400);
  }

  if (!EXPLORE_SOURCE_TYPES.has(body.source_type as SourceType)) {
    return errorResponse("BAD_REQUEST", "Invalid source_type", 400);
  }

  const user = c.get("user") as AuthUser;
  const db = drizzle(c.env.DB);
  const maxSubs = Number(c.env.MAX_SUBSCRIPTIONS ?? "10");

  // Count existing subscriptions
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  if (countResult[0].count >= maxSubs) {
    return errorResponse("MAX_SUBSCRIPTIONS", `Maximum subscriptions (${maxSubs}) reached`, 409);
  }

  // Fetch target schedule and generate ICS
  const accessToken = await decrypt(user.accessToken!, c.env.ENCRYPTION_KEY);
  const api = new CQUAPIClient(accessToken);

  try {
    const ctx = await fetchSessionContextCached(api, c.env.CACHE);
    const sessionId = ctx.semesterInfo.id ? String(ctx.semesterInfo.id) : "";
    const sessionName = ctx.semesterInfo.name;

    // Check for duplicate with direct query (hits UNIQUE index)
    const duplicate = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.sourceType, body.source_type as SourceType),
          eq(subscriptions.sourceId, body.source_id),
          eq(subscriptions.sessionId, sessionId),
        ),
      )
      .limit(1);

    if (duplicate.length > 0) {
      return errorResponse("SUBSCRIPTION_DUPLICATE", "Subscription already exists for this session", 409);
    }

    const result = await buildExploreSyncResult(
      api,
      body.source_type as ExploreSourceType,
      body.source_id,
      user.studentId,
      ctx,
    );

    const now = new Date().toISOString();
    const subToken = generateToken();
    const baseUrl = (c.env.PUBLIC_URL ?? "").replace(/\/$/, "");

    const [newSub] = await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        sourceType: body.source_type as ExploreSourceType,
        sourceId: body.source_id,
        sourceName: body.source_name,
        calendarToken: subToken,
        sessionId,
        sessionName,
        semesterStart: result.semesterStart,
        isPersonal: false,
        icsContent: result.icsContent,
        coursesJson: result.coursesJson,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return c.json({
      calendar_token: newSub.calendarToken,
      subscription_url: `${baseUrl}/api/v1/subscriptions/${newSub.calendarToken}/calendar.ics`,
      source_type: newSub.sourceType,
      source_name: newSub.sourceName,
      session_name: newSub.sessionName,
      created_at: newSub.createdAt,
    }, 201);
  } catch (e) {
    return handleCquApiError(c, e, "Failed to fetch schedule");
  }
});

// DELETE /api/v1/subscriptions/:sub_token
app.delete("/:sub_token", requireAuth, rateLimit("AUTH_LIMITER"), async (c) => {
  const subToken = c.req.param("sub_token");
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({
      id: subscriptions.id,
      isPersonal: subscriptions.isPersonal,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.calendarToken, subToken),
        eq(subscriptions.userId, user.id),
      ),
    )
    .limit(1);

  if (!sub) return errorResponse("NOT_FOUND", "Subscription not found", 404);
  if (sub.isPersonal)
    return errorResponse("FORBIDDEN", "Cannot delete personal subscriptions", 403);

  await db.delete(subscriptions).where(eq(subscriptions.id, sub.id));
  return c.body(null, 204);
});

// POST /api/v1/subscriptions/:sub_token/refresh
app.post("/:sub_token/refresh", requireAuthWithCquToken, rateLimit("AUTH_LIMITER"), async (c) => {
  const subToken = c.req.param("sub_token");
  const user = c.get("user") as AuthUser;
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({
      id: subscriptions.id,
      sourceType: subscriptions.sourceType,
      sourceId: subscriptions.sourceId,
      sessionId: subscriptions.sessionId,
      sessionName: subscriptions.sessionName,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.calendarToken, subToken),
        eq(subscriptions.userId, user.id),
      ),
    )
    .limit(1);

  if (!sub) return errorResponse("NOT_FOUND", "Subscription not found", 404);

  const accessToken = await decrypt(user.accessToken!, c.env.ENCRYPTION_KEY);
  const api = new CQUAPIClient(accessToken);

  try {
    const ctx = await fetchSessionContextCached(api, c.env.CACHE);
    let result;

    if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
      const data = await fetchPersonalScheduleCached(api, user.studentId, ctx, c.env.CACHE);
      const ics = preGenerateIcs(data, user.studentId);
      result = buildPersonalSyncResult(sub.sourceType, data, ics);
    } else {
      result = await buildExploreSyncResult(
        api,
        sub.sourceType as ExploreSourceType,
        sub.sourceId,
        user.studentId,
        ctx,
      );
    }

    await applySyncResult(db, sub.id, result, ctx, {
      sessionId: sub.sessionId,
      sessionName: sub.sessionName,
    });
  } catch (e) {
    return handleCquApiError(c, e, "Refresh failed");
  }

  return c.json({ success: true });
});

// GET /api/v1/subscriptions/:sub_token/calendar.ics (public)
app.get("/:sub_token/calendar.ics", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const subToken = c.req.param("sub_token");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({ icsContent: subscriptions.icsContent })
    .from(subscriptions)
    .where(eq(subscriptions.calendarToken, subToken))
    .limit(1);

  if (!sub) {
    return errorResponse("NOT_FOUND", "Subscription not found", 404);
  }
  return new Response(sub.icsContent ?? EMPTY_ICS, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="schedule.ics"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

// GET /api/v1/subscriptions/:sub_token/origin.json (public)
app.get("/:sub_token/origin.json", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const sub = await getSubForExport(c);
  if (sub instanceof Response) return sub;

  const parsed = parseSubJson(sub);
  if (!parsed) return errorResponse("DATA_CORRUPTED", "Stored data is corrupted", 500);

  return new Response(JSON.stringify({
    courses: parsed.courses ?? [],
    exams: parsed.exams ?? [],
  }), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="origin.json"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

// GET /api/v1/subscriptions/:sub_token/data.json (public)
app.get("/:sub_token/data.json", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const sub = await getSubForExport(c);
  if (sub instanceof Response) return sub;

  const parsed = parseSubJson(sub);
  if (!parsed) return errorResponse("DATA_CORRUPTED", "Stored data is corrupted", 500);

  const events = generateFormattedEvents(
    parsed.courses,
    sub.semesterStart ?? "",
    parsed.exams,
  );

  return new Response(JSON.stringify({
    semester: semesterShortName(sub.sessionName),
    semester_start: sub.semesterStart ?? "",
    generated_at: new Date().toISOString(),
    events,
  }), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="data.json"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

// GET /api/v1/subscriptions/:sub_token/data.csv (public)
app.get("/:sub_token/data.csv", rateLimit("UNAUTH_LIMITER"), async (c) => {
  const sub = await getSubForExport(c);
  if (sub instanceof Response) return sub;

  const parsed = parseSubJson(sub);
  if (!parsed) return errorResponse("DATA_CORRUPTED", "Stored data is corrupted", 500);

  const events = generateFormattedEvents(
    parsed.courses,
    sub.semesterStart ?? "",
    parsed.exams,
  );

  return new Response(generateCsv(events), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="schedule.csv"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

type ExportSub = Pick<Subscription, 'coursesJson' | 'examsJson' | 'semesterStart' | 'sessionName'>;

function parseSubJson(sub: ExportSub): { courses: CourseEntry[] | null; exams: ExamEntry[] | null } | null {
  try {
    return {
      courses: sub.coursesJson ? JSON.parse(sub.coursesJson) : null,
      exams: sub.examsJson ? JSON.parse(sub.examsJson) : null,
    };
  } catch {
    return null;
  }
}

async function getSubForExport(c: Context<AuthEnv>): Promise<ExportSub | Response> {
  const subToken = c.req.param("sub_token");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select({
      coursesJson: subscriptions.coursesJson,
      examsJson: subscriptions.examsJson,
      semesterStart: subscriptions.semesterStart,
      sessionName: subscriptions.sessionName,
    })
    .from(subscriptions)
    .where(eq(subscriptions.calendarToken, subToken))
    .limit(1);

  if (!sub) {
    return errorResponse("NOT_FOUND", "Subscription not found", 404);
  }
  if (sub.coursesJson === null && sub.examsJson === null) {
    return errorResponse("NOT_SYNCED", "Subscription data not yet available", 202);
  }

  return sub;
}

export default app;
