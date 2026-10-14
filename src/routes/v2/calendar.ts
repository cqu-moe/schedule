import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  subscriptions,
  calendarLinks,
  type LinkFormat,
  type PersonalViewType,
  type Subscription,
} from "../../db/schema";
import type { Env } from "../../types";
import { rateLimit } from "../../middleware/rate-limit";
import { linkAllows } from "../../services/links";
import {
  semesterShortName,
  generateFormattedEvents,
  generateCsv,
} from "../../services/export";
import { EMPTY_ICS } from "../../services/ics";
import type { CourseEntry, ExamEntry } from "../../services/cqu-api";
import { errorResponse } from "../../utils/error";
import { projectPersonalCalendar } from "../../services/personal-calendar-projection";
import { captureScheduleEvent } from "../../lib/posthog";

const app = new Hono<{ Bindings: Env }>();

// ════════════════════════════════════════════════════════════════════════════
//  Public calendar endpoints — addressed by link token, no login required.
//  Token not found → 404 (uniform, to avoid enumeration).
//  Token valid but the requested format is not in the link's allow-list → 403.
// ════════════════════════════════════════════════════════════════════════════

/** Joined link + its subscription's export-relevant fields. */
interface ResolvedLink {
  subscriptionId: string;
  formats: string;
  isActive: boolean;
  isDefault: boolean;
  linkIsActive: boolean;
  icsContent: string | null;
  coursesJson: string | null;
  examsJson: string | null;
  semesterStart: string | null;
  sessionName: string | null;
  sourceType: string;
  sourceVersion: number;
  externalState: string;
  lastSyncedAt: string | null;
  sourceId: string;
  personalViewType: PersonalViewType | null;
}

/**
 * Look up a link by token, joining the export-relevant subscription columns.
 * Returns the resolved row, or `null` when no link with that token exists.
 */
async function resolveLink(
  db: DrizzleD1Database,
  token: string,
): Promise<ResolvedLink | null> {
  const [row] = await db
    .select({
      subscriptionId: subscriptions.id,
      formats: calendarLinks.formats,
      isActive: subscriptions.isActive,
      isDefault: calendarLinks.isDefault,
      linkIsActive: calendarLinks.isActive,
      icsContent: subscriptions.icsContent,
      coursesJson: subscriptions.coursesJson,
      examsJson: subscriptions.examsJson,
      semesterStart: subscriptions.semesterStart,
      sessionName: subscriptions.sessionName,
      sourceType: subscriptions.sourceType,
      sourceVersion: subscriptions.sourceVersion,
      externalState: subscriptions.externalState,
      lastSyncedAt: subscriptions.lastSyncedAt,
      sourceId: subscriptions.sourceId,
      personalViewType: calendarLinks.personalViewType,
    })
    .from(calendarLinks)
    .innerJoin(subscriptions, eq(calendarLinks.subscriptionId, subscriptions.id))
    .where(eq(calendarLinks.token, token))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a token to its link, or a 404 Response if unknown. Mirrors the old
 * `getSubForExport` shape: callers do `if (link instanceof Response) return link;`.
 */
async function resolveLinkOr404(
  db: DrizzleD1Database,
  token: string,
): Promise<ResolvedLink | Response> {
  const link = await resolveLink(db, token);
  if (!link) return errorResponse("NOT_FOUND", "链接不存在", 404);
  // Hard revocation: the owner's required calendar cap was revoked → the cron
  // producer / manual refresh flipped is_active false. Stop serving the link.
  if (!link.isActive) return errorResponse("SUBSCRIPTION_INACTIVE", "该订阅已停用", 403);
  // Share revocation (issue #89): the owner lost caps.share → the cron producer /
  // manual refresh reconciled non-default links inactive. Default links keep
  // serving; their gate is the subscription isActive check above.
  if (!link.isDefault && !link.linkIsActive) {
    return errorResponse("LINK_INACTIVE", "该链接已停用", 403);
  }
  if (link.sourceVersion === 1) {
    if (link.externalState !== "active") return errorResponse("SUBSCRIPTION_INACTIVE", "该订阅已停用，请主人重新选择教学班", 403);
    if (!link.lastSyncedAt) return errorResponse("INITIAL_SYNC_PENDING", "首次同步尚未完成，请稍后重试", 503);
  }
  const view = link.sourceType === "personal" ? link.personalViewType : null;
  if (link.sourceType === "personal" && !view) {
    return errorResponse("NOT_FOUND", "链接不存在", 404);
  }
  if (view) {
    try {
      const projected = projectPersonalCalendar(link as unknown as Subscription, view);
      link.icsContent = projected.icsContent;
      link.coursesJson = projected.coursesJson;
      link.examsJson = projected.examsJson;
    } catch {
      return errorResponse("DATA_CORRUPTED", "存储数据已损坏", 500);
    }
  }
  return link;
}

/**
 * Enforce that the link's stored formats allow `fmt`. Returns a 403 Response
 * when not allowed, otherwise `null` (proceed).
 */
function gateFormat(link: ResolvedLink, fmt: LinkFormat): Response | null {
  if (!linkAllows(link.formats, fmt)) {
    return errorResponse("FORMAT_NOT_ALLOWED", "该链接不允许此格式", 403);
  }
  return null;
}

/** Parsed courses/exams, or `null` when either stored JSON is malformed. */
function parseLinkJson(
  link: ResolvedLink,
): { courses: CourseEntry[] | null; exams: ExamEntry[] | null } | null {
  try {
    return {
      courses: link.coursesJson ? (JSON.parse(link.coursesJson) as CourseEntry[]) : null,
      exams: link.examsJson ? (JSON.parse(link.examsJson) as ExamEntry[]) : null,
    };
  } catch {
    return null;
  }
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.clone().json() as { detail?: { error?: { code?: unknown } } };
    const code = body.detail?.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function captureCalendarDelivery(
  c: { env: Env; executionCtx: ExecutionContext },
  format: LinkFormat,
  outcome: "success" | "failure",
  link: Pick<ResolvedLink, "subscriptionId" | "sourceType" | "personalViewType"> | null,
  errorCode?: string,
): void {
  let lifecycle: ExecutionContext | undefined;
  try {
    lifecycle = c.executionCtx;
  } catch {
    lifecycle = undefined;
  }
  captureScheduleEvent(
    c.env,
    lifecycle,
    "schedule_calendar_delivered",
    link ? `subscription:${link.subscriptionId}` : crypto.randomUUID(),
    {
      actor_type: "system",
      trigger: "automatic",
      operation: format,
      outcome,
      format,
      ...(link ? { subscription_id: link.subscriptionId } : {}),
      ...(link ? { source_type: link.sourceType } : {}),
      ...(link?.personalViewType ? { view_type: link.personalViewType } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
    },
    false,
  );
}

async function deliverCalendar(
  c: { env: Env; executionCtx: ExecutionContext; req: { param: (name: string) => string } },
  format: LinkFormat,
  produce: (link: ResolvedLink) => Promise<Response>,
): Promise<Response> {
  let link: ResolvedLink | null = null;
  try {
    const db = drizzle(c.env.DB);
    const resolved = await resolveLinkOr404(db, c.req.param("token"));
    if (resolved instanceof Response) {
      captureCalendarDelivery(c, format, "failure", null, await responseErrorCode(resolved));
      return resolved;
    }
    link = resolved;

    const gated = gateFormat(link, format);
    if (gated) {
      captureCalendarDelivery(c, format, "failure", link, await responseErrorCode(gated));
      return gated;
    }

    const response = await produce(link);
    captureCalendarDelivery(
      c,
      format,
      response.status < 400 ? "success" : "failure",
      link,
      response.status < 400 ? undefined : await responseErrorCode(response),
    );
    return response;
  } catch (error) {
    captureCalendarDelivery(c, format, "failure", link, "CALENDAR_DELIVERY_FAILED");
    throw error;
  }
}

// Token endpoints use `public, max-age=300` by DESIGN: tokens are unguessable and
// per-link, the payload is low-sensitivity course-schedule data, and edge-caching
// frequently-polled ICS feeds meaningfully cuts Worker invocations. The tradeoff
// is a ≤5min window where a just-deleted/rotated link may still serve from cache —
// accepted given the low sensitivity. Tighten (e.g. no-store) only if a future
// endpoint serves sensitive data needing instant revocation.

// ── GET /:token/calendar.ics ─────────────────────────────────────────────────
app.get("/:token/calendar.ics", rateLimit("UNAUTH_LIMITER"), async (c) => {
  return deliverCalendar(c, "ics", async (link) => new Response(link.icsContent ?? EMPTY_ICS, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="schedule.ics"',
      "Cache-Control": "public, max-age=300",
    },
  }));
});

// ── GET /:token/origin.json — raw courses + exams ────────────────────────────
app.get("/:token/origin.json", rateLimit("UNAUTH_LIMITER"), async (c) => {
  return deliverCalendar(c, "origin_json", async (link) => {
    const parsed = parseLinkJson(link);
    if (!parsed) return errorResponse("DATA_CORRUPTED", "存储数据已损坏", 500);
    return new Response(
      JSON.stringify({ courses: parsed.courses ?? [], exams: parsed.exams ?? [] }),
      {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="origin.json"',
        "Cache-Control": "public, max-age=300",
      },
      },
    );
  });
});

// ── GET /:token/data.json — formatted events + metadata ──────────────────────
app.get("/:token/data.json", rateLimit("UNAUTH_LIMITER"), async (c) => {
  return deliverCalendar(c, "data_json", async (link) => {
    const parsed = parseLinkJson(link);
    if (!parsed) return errorResponse("DATA_CORRUPTED", "存储数据已损坏", 500);
    const events = generateFormattedEvents(
      parsed.courses,
      link.semesterStart ?? "",
      parsed.exams,
    );
    return new Response(
      JSON.stringify({
        semester: semesterShortName(link.sessionName),
        semester_start: link.semesterStart ?? "",
        generated_at: new Date().toISOString(),
        events,
      }),
      {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="data.json"',
        "Cache-Control": "public, max-age=300",
      },
      },
    );
  });
});

// ── GET /:token/data.csv ─────────────────────────────────────────────────────
app.get("/:token/data.csv", rateLimit("UNAUTH_LIMITER"), async (c) => {
  return deliverCalendar(c, "csv", async (link) => {
    const parsed = parseLinkJson(link);
    if (!parsed) return errorResponse("DATA_CORRUPTED", "存储数据已损坏", 500);
    const events = generateFormattedEvents(
      parsed.courses,
      link.semesterStart ?? "",
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
});

// ── GET /:token/view.json — read-only web view data (gated on "web") ─────────
//  Same event payload as data.json, but the gate checks the "web" format and
//  no attachment header is set (the frontend fetches this via XHR).
app.get("/:token/view.json", rateLimit("UNAUTH_LIMITER"), async (c) => {
  return deliverCalendar(c, "web", async (link) => {
    const parsed = parseLinkJson(link);
    if (!parsed) return errorResponse("DATA_CORRUPTED", "存储数据已损坏", 500);
    const events = generateFormattedEvents(
      parsed.courses,
      link.semesterStart ?? "",
      parsed.exams,
    );
    return new Response(
      JSON.stringify({
        semester: semesterShortName(link.sessionName),
        semester_start: link.semesterStart ?? "",
        generated_at: new Date().toISOString(),
        events,
      }),
      {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
      },
    );
  });
});

export default app;
