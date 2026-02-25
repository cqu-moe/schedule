import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, desc, asc } from "drizzle-orm";
import { users, subscriptions, type User, type Subscription } from "../db/schema";
import type { Env } from "../types";
import { requireAuth, requireAuthWithCquToken } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { verifyCaptcha, CaptchaError } from "../services/captcha";
import {
  CQUAPIClient,
  type CourseEntry,
  type ExamEntry,
} from "../services/cqu-api";
import {
  generateCoursesIcs,
  generateExamsIcs,
  mergeIcs,
} from "../services/ics";
import {
  semesterShortName,
  generateFormattedEvents,
  generateCsv,
} from "../services/export";

const PERSONAL_SOURCE_TYPES = new Set([
  "personal_all",
  "personal_courses",
  "personal_exams",
]);

type AuthEnv = { Bindings: Env; Variables: { user: User } };

const app = new Hono<AuthEnv>();

function generateSubToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// GET /api/v1/subscriptions
app.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const baseUrl = (c.env.PUBLIC_URL ?? "").replace(/\/$/, "");

  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .orderBy(desc(subscriptions.isPersonal), asc(subscriptions.createdAt));

  const exploreCount = subs.filter((s) => !s.isPersonal).length;

  return c.json({
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
    count: exploreCount,
    max: Number(c.env.MAX_SUBSCRIPTIONS ?? "5"),
  });
});

// POST /api/v1/subscriptions
app.post("/", requireAuthWithCquToken, rateLimit("EXPLORE_LIMITER"), async (c) => {
  const captchaToken = c.req.header("X-Captcha-Token") ?? null;
  try {
    await verifyCaptcha(c.env, captchaToken);
  } catch (e) {
    if (e instanceof CaptchaError) return c.json({ detail: e.message }, 403);
    throw e;
  }

  const body = await c.req.json<{
    source_type: string;
    source_id: string;
    source_name: string;
  }>();

  const validTypes = [
    "instructor",
    "room",
    "laboratory",
    "course",
    "admin_class",
  ];
  if (!validTypes.includes(body.source_type)) {
    return c.json({ detail: "Invalid source_type" }, 400);
  }

  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const maxSubs = Number(c.env.MAX_SUBSCRIPTIONS ?? "5");

  // Count existing explore subs
  const existingSubs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.isPersonal, false),
      ),
    );

  if (existingSubs.length >= maxSubs) {
    return c.json(
      { detail: `Maximum subscriptions (${maxSubs}) reached` },
      409,
    );
  }

  // Fetch target schedule via CQU API directly
  const api = new CQUAPIClient(user.accessToken!);
  let courses: CourseEntry[];
  let semesterInfo;

  try {
    const sessionList = await api.getSessionList();
    const currentSessionId = sessionList.current_session_id;
    semesterInfo = await api.getSemesterInfo(currentSessionId);
    courses = await api.fetchTargetSchedule(
      body.source_type,
      body.source_id,
      currentSessionId,
    );
  } catch (e: any) {
    if (e?.statusCode === 401) {
      return c.json(
        { detail: "CQU token expired, please re-login" },
        401,
      );
    }
    return c.json({ detail: e?.message ?? "Failed to fetch schedule" }, 502);
  }

  const sessionId = semesterInfo.id ? String(semesterInfo.id) : "";
  const sessionName = semesterInfo.name;

  // Check for duplicate
  for (const s of existingSubs) {
    if (
      s.sourceType === body.source_type &&
      s.sourceId === body.source_id &&
      s.sessionId === sessionId
    ) {
      return c.json(
        { detail: "Subscription already exists for this session" },
        409,
      );
    }
  }

  // Generate ICS
  const icsContent = await generateCoursesIcs(
    courses,
    semesterInfo.begin_date ?? "",
    user.studentId,
  );

  const now = new Date().toISOString();
  const subToken = generateSubToken();
  const baseUrl = (c.env.PUBLIC_URL ?? "").replace(/\/$/, "");

  const [newSub] = await db
    .insert(subscriptions)
    .values({
      userId: user.id,
      sourceType: body.source_type,
      sourceId: body.source_id,
      sourceName: body.source_name,
      calendarToken: subToken,
      sessionId,
      sessionName,
      semesterStart: semesterInfo.begin_date ?? "",
      isPersonal: false,
      icsContent,
      coursesJson: JSON.stringify(courses),
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
  });
});

// DELETE /api/v1/subscriptions/:sub_token
app.delete("/:sub_token", requireAuth, async (c) => {
  const subToken = c.req.param("sub_token");
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.calendarToken, subToken),
        eq(subscriptions.userId, user.id),
      ),
    )
    .limit(1);

  if (!sub) return c.json({ detail: "Subscription not found" }, 404);
  if (sub.isPersonal)
    return c.json({ detail: "Cannot delete personal subscriptions" }, 403);

  await db.delete(subscriptions).where(eq(subscriptions.id, sub.id));
  return c.json({ success: true });
});

// POST /api/v1/subscriptions/:sub_token/refresh
app.post("/:sub_token/refresh", requireAuthWithCquToken, rateLimit("AUTH_LIMITER"), async (c) => {
  const subToken = c.req.param("sub_token");
  const user = c.get("user");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.calendarToken, subToken),
        eq(subscriptions.userId, user.id),
      ),
    )
    .limit(1);

  if (!sub) return c.json({ detail: "Subscription not found" }, 404);

  const api = new CQUAPIClient(user.accessToken!);
  const now = new Date().toISOString();

  try {
    if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
      const sessionList = await api.getSessionList();
      const currentSessionId = sessionList.current_session_id;
      const semesterInfo = await api.getSemesterInfo(currentSessionId);
      const semesterStart = semesterInfo.begin_date ?? "";
      const courses = await api.getSchedule(user.studentId, currentSessionId);
      const exams = await api.getExams();

      const coursesIcs = await generateCoursesIcs(
        courses,
        semesterStart,
        user.studentId,
      );
      const examsIcs =
        exams.length > 0
          ? await generateExamsIcs(exams, user.studentId)
          : null;

      let icsContent: string | null;
      let coursesJsonStr: string | null;
      let examsJsonStr: string | null;

      if (sub.sourceType === "personal_all") {
        icsContent = examsIcs ? mergeIcs(coursesIcs, examsIcs) : coursesIcs;
        coursesJsonStr = JSON.stringify(courses);
        examsJsonStr = exams.length > 0 ? JSON.stringify(exams) : null;
      } else if (sub.sourceType === "personal_courses") {
        icsContent = coursesIcs;
        coursesJsonStr = JSON.stringify(courses);
        examsJsonStr = null;
      } else {
        // personal_exams
        icsContent = examsIcs;
        coursesJsonStr = null;
        examsJsonStr = exams.length > 0 ? JSON.stringify(exams) : null;
      }

      await db
        .update(subscriptions)
        .set({
          icsContent,
          coursesJson: coursesJsonStr,
          examsJson: examsJsonStr,
          semesterStart,
          sessionId: semesterInfo.id ? String(semesterInfo.id) : sub.sessionId,
          sessionName: semesterInfo.name || sub.sessionName,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, sub.id));
    } else {
      // Explore subscriptions
      const sessionList = await api.getSessionList();
      const currentSessionId = sessionList.current_session_id;
      const semesterInfo = await api.getSemesterInfo(currentSessionId);
      const courses = await api.fetchTargetSchedule(
        sub.sourceType,
        sub.sourceId,
        currentSessionId,
      );

      const icsContent = await generateCoursesIcs(
        courses,
        semesterInfo.begin_date ?? "",
        user.studentId,
      );

      await db
        .update(subscriptions)
        .set({
          icsContent,
          coursesJson: JSON.stringify(courses),
          semesterStart: semesterInfo.begin_date ?? "",
          sessionId: semesterInfo.id
            ? String(semesterInfo.id)
            : sub.sessionId,
          sessionName: semesterInfo.name || sub.sessionName,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, sub.id));
    }
  } catch (e: any) {
    if (e?.statusCode === 401) {
      return c.json(
        { detail: "CQU token expired, please re-login" },
        401,
      );
    }
    return c.json({ detail: e?.message ?? "Refresh failed" }, 502);
  }

  return c.json({ success: true });
});

// GET /api/v1/subscriptions/:sub_token/calendar.ics (public)
app.get("/:sub_token/calendar.ics", async (c) => {
  const subToken = c.req.param("sub_token");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.calendarToken, subToken))
    .limit(1);

  if (!sub || !sub.icsContent) {
    return c.json({ detail: "Subscription not found or no data" }, 404);
  }

  return new Response(sub.icsContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="schedule.ics"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

// GET /api/v1/subscriptions/:sub_token/origin.json (public)
app.get("/:sub_token/origin.json", async (c) => {
  const sub = await getSubForExport(c);
  if (sub instanceof Response) return sub;

  const courses = sub.coursesJson ? JSON.parse(sub.coursesJson) : [];
  const exams = sub.examsJson ? JSON.parse(sub.examsJson) : [];

  return new Response(JSON.stringify({ courses, exams }), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="origin.json"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

// GET /api/v1/subscriptions/:sub_token/data.json (public)
app.get("/:sub_token/data.json", async (c) => {
  const sub = await getSubForExport(c);
  if (sub instanceof Response) return sub;

  const courses = sub.coursesJson ? JSON.parse(sub.coursesJson) : null;
  const exams = sub.examsJson ? JSON.parse(sub.examsJson) : null;
  const events = generateFormattedEvents(
    courses,
    sub.semesterStart ?? "",
    exams,
  );

  const payload = {
    semester: semesterShortName(sub.sessionName),
    semester_start: sub.semesterStart ?? "",
    generated_at: new Date().toISOString(),
    events,
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="data.json"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

// GET /api/v1/subscriptions/:sub_token/data.csv (public)
app.get("/:sub_token/data.csv", async (c) => {
  const sub = await getSubForExport(c);
  if (sub instanceof Response) return sub;

  const courses = sub.coursesJson ? JSON.parse(sub.coursesJson) : null;
  const exams = sub.examsJson ? JSON.parse(sub.examsJson) : null;
  const events = generateFormattedEvents(
    courses,
    sub.semesterStart ?? "",
    exams,
  );
  const csvContent = generateCsv(events);

  return new Response(csvContent, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="schedule.csv"',
      "Cache-Control": "public, max-age=300",
    },
  });
});

async function getSubForExport(c: any): Promise<Subscription | Response> {
  const subToken = c.req.param("sub_token");
  const db = drizzle(c.env.DB);

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.calendarToken, subToken))
    .limit(1);

  if (!sub || (sub.coursesJson === null && sub.examsJson === null)) {
    return c.json({ detail: "Subscription not found or no data" }, 404);
  }

  return sub;
}

export default app;
