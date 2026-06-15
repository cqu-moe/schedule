import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  subscriptions,
  PERSONAL_SOURCE_TYPES,
  type SourceType,
  type ExternalSourceType,
} from "../db/schema";
import {
  CQUAPIClient,
  type CourseEntry,
  type ExamEntry,
  type SemesterInfo,
} from "./cqu-api";
import {
  generateCoursesIcs,
  generateExamsIcs,
  mergeIcs,
  EMPTY_ICS,
} from "./ics";

export interface SessionContext {
  sessionId: string;
  semesterInfo: SemesterInfo;
}

export interface PersonalScheduleData {
  courses: CourseEntry[];
  exams: ExamEntry[];
  semesterStart: string;
}

export interface SyncResult {
  icsContent: string | null;
  coursesJson: string | null;
  examsJson: string | null;
  semesterStart: string;
}

/** Fetch current session + semester info from CQU API */
export async function fetchSessionContext(
  api: CQUAPIClient,
): Promise<SessionContext> {
  const sessionList = await api.getSessionList();
  const sessionId = sessionList.current_session_id;
  const semesterInfo = await api.getSemesterInfo(sessionId);
  return { sessionId, semesterInfo };
}

/**
 * Build a {@link SessionContext} for a specific (possibly non-current) session.
 *
 * Used when an external subscription pins an explicit `sessionId` so its sync
 * targets that semester instead of the always-current cached context.
 */
export async function fetchSessionContextFor(
  api: CQUAPIClient,
  sessionId: string,
): Promise<SessionContext> {
  const semesterInfo = await api.getSemesterInfo(sessionId);
  return { sessionId, semesterInfo };
}

const SESSION_CACHE_KEY = "session:current";
const SESSION_CACHE_TTL = 86400; // 24 hours

/** Fetch SessionContext with KV cache (24h TTL) */
export async function fetchSessionContextCached(
  api: CQUAPIClient,
  kv: KVNamespace,
): Promise<SessionContext> {
  const cached = await kv.get(SESSION_CACHE_KEY, "json");
  if (cached) return cached as SessionContext;

  const ctx = await fetchSessionContext(api);
  await kv.put(SESSION_CACHE_KEY, JSON.stringify(ctx), {
    expirationTtl: SESSION_CACHE_TTL,
  });
  return ctx;
}

const PERSONAL_CACHE_TTL = 300; // 5 minutes

/** Fetch personal schedule with KV cache to deduplicate across requests */
export async function fetchPersonalScheduleCached(
  api: CQUAPIClient,
  studentId: string,
  ctx: SessionContext,
  kv: KVNamespace,
): Promise<PersonalScheduleData> {
  const cacheKey = `sync:personal:${studentId}`;
  const cached = await kv.get(cacheKey, "json");
  if (cached) return cached as PersonalScheduleData;

  const data = await fetchPersonalSchedule(api, studentId, ctx);
  kv.put(cacheKey, JSON.stringify(data), { expirationTtl: PERSONAL_CACHE_TTL }).catch(() => {});
  return data;
}

/** Fetch personal schedule (courses + exams) */
export async function fetchPersonalSchedule(
  api: CQUAPIClient,
  studentId: string,
  ctx: SessionContext,
): Promise<PersonalScheduleData> {
  const [courses, exams] = await Promise.all([
    api.getSchedule(studentId, ctx.sessionId),
    api.getExams(),
  ]);
  return {
    courses,
    exams,
    semesterStart: ctx.semesterInfo.begin_date ?? "",
  };
}

export interface PreGeneratedIcs {
  coursesIcs: string;
  examsIcs: string | null;
}

/** Pre-generate ICS content once for reuse across multiple subscription types */
export function preGenerateIcs(
  data: PersonalScheduleData,
  studentId: string,
): PreGeneratedIcs {
  return {
    coursesIcs: generateCoursesIcs(data.courses, data.semesterStart, studentId),
    examsIcs: data.exams.length > 0 ? generateExamsIcs(data.exams, studentId) : null,
  };
}

/** Generate ICS + JSON for a personal subscription based on sourceType */
export function buildPersonalSyncResult(
  sourceType: SourceType,
  data: PersonalScheduleData,
  ics: PreGeneratedIcs,
): SyncResult {
  let icsContent: string | null;
  let coursesJson: string | null;
  let examsJson: string | null;

  if (sourceType === "personal_all") {
    icsContent = ics.examsIcs ? mergeIcs(ics.coursesIcs, ics.examsIcs) : ics.coursesIcs;
    coursesJson = JSON.stringify(data.courses);
    examsJson = data.exams.length > 0 ? JSON.stringify(data.exams) : null;
  } else if (sourceType === "personal_courses") {
    icsContent = ics.coursesIcs;
    coursesJson = JSON.stringify(data.courses);
    examsJson = null;
  } else {
    icsContent = ics.examsIcs ?? EMPTY_ICS;
    coursesJson = null;
    examsJson = data.exams.length > 0 ? JSON.stringify(data.exams) : null;
  }

  return { icsContent, coursesJson, examsJson, semesterStart: data.semesterStart };
}

/** Fetch target schedule and generate ICS for an external subscription */
export async function buildExternalSyncResult(
  api: CQUAPIClient,
  sourceType: ExternalSourceType,
  sourceId: string,
  studentId: string,
  ctx: SessionContext,
): Promise<SyncResult> {
  const courses = await api.fetchTargetSchedule(
    sourceType,
    sourceId,
    ctx.sessionId,
  );
  const semesterStart = ctx.semesterInfo.begin_date ?? "";
  const icsContent = generateCoursesIcs(courses, semesterStart, studentId);

  return {
    icsContent,
    coursesJson: JSON.stringify(courses),
    examsJson: null,
    semesterStart,
  };
}

/** Apply sync result to a subscription row */
export async function applySyncResult(
  db: ReturnType<typeof drizzle>,
  subId: string,
  result: SyncResult,
  ctx: SessionContext,
  fallback: { sessionId: string | null; sessionName: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(subscriptions)
    .set({
      icsContent: result.icsContent,
      coursesJson: result.coursesJson,
      examsJson: result.examsJson,
      semesterStart: result.semesterStart,
      sessionId: ctx.semesterInfo.id
        ? String(ctx.semesterInfo.id)
        : fallback.sessionId,
      sessionName: ctx.semesterInfo.name || fallback.sessionName,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, subId));
}
