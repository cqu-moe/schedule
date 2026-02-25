import { drizzle } from "drizzle-orm/d1";
import { isNotNull, eq } from "drizzle-orm";
import { users, subscriptions } from "../db/schema";
import type { Env } from "../types";
import {
  CQUAPIClient,
  CQUAPIError,
  type CourseEntry,
  type ExamEntry,
} from "../services/cqu-api";
import {
  generateCoursesIcs,
  generateExamsIcs,
  mergeIcs,
} from "../services/ics";

const PERSONAL_SOURCE_TYPES = new Set([
  "personal_all",
  "personal_courses",
  "personal_exams",
]);

export async function syncAllSubscriptions(env: Env): Promise<void> {
  console.log("cron: starting schedule sync");
  const db = drizzle(env.DB);

  // Get all users with valid access tokens
  const activeUsers = await db
    .select()
    .from(users)
    .where(isNotNull(users.accessToken));

  if (activeUsers.length === 0) {
    console.log("cron: no active users, skipping sync");
    return;
  }

  console.log(`cron: syncing subscriptions for ${activeUsers.length} users`);

  for (const user of activeUsers) {
    try {
      await syncUserSubscriptions(env, db, user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `cron: failed to sync subscriptions for ${user.studentId}: ${msg}`,
      );
    }
  }

  console.log("cron: schedule sync complete");
}

async function syncUserSubscriptions(
  env: Env,
  db: ReturnType<typeof drizzle>,
  user: typeof users.$inferSelect,
): Promise<void> {
  if (!user.accessToken) return;

  const userSubs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  if (userSubs.length === 0) return;

  const api = new CQUAPIClient(user.accessToken);
  const now = new Date().toISOString();

  // Cache: personal schedule data (shared across personal_all/courses/exams)
  let personalData: {
    courses: CourseEntry[];
    exams: ExamEntry[];
    semesterStart: string;
    sessionId: string | null;
    sessionName: string;
  } | null = null;
  let personalFetchFailed = false;

  for (const sub of userSubs) {
    try {
      if (PERSONAL_SOURCE_TYPES.has(sub.sourceType)) {
        // Fetch personal data once
        if (!personalData && !personalFetchFailed) {
          try {
            const sessionList = await api.getSessionList();
            const currentSessionId = sessionList.current_session_id;
            const semesterInfo = await api.getSemesterInfo(currentSessionId);
            const courses = await api.getSchedule(
              user.studentId,
              currentSessionId,
            );
            const exams = await api.getExams();

            personalData = {
              courses,
              exams,
              semesterStart: semesterInfo.begin_date ?? "",
              sessionId: semesterInfo.id,
              sessionName: semesterInfo.name,
            };
          } catch (e) {
            personalFetchFailed = true;
            console.error(
              `cron: failed to fetch personal schedule for ${user.studentId}: ${e}`,
            );
            continue;
          }
        }

        if (!personalData) continue;

        const coursesIcs = await generateCoursesIcs(
          personalData.courses,
          personalData.semesterStart,
          user.studentId,
        );
        const examsIcs =
          personalData.exams.length > 0
            ? await generateExamsIcs(personalData.exams, user.studentId)
            : null;

        let icsContent: string | null;
        let coursesJsonStr: string | null;
        let examsJsonStr: string | null;

        if (sub.sourceType === "personal_all") {
          icsContent = examsIcs
            ? mergeIcs(coursesIcs, examsIcs)
            : coursesIcs;
          coursesJsonStr = JSON.stringify(personalData.courses);
          examsJsonStr =
            personalData.exams.length > 0
              ? JSON.stringify(personalData.exams)
              : null;
        } else if (sub.sourceType === "personal_courses") {
          icsContent = coursesIcs;
          coursesJsonStr = JSON.stringify(personalData.courses);
          examsJsonStr = null;
        } else {
          // personal_exams
          icsContent = examsIcs;
          coursesJsonStr = null;
          examsJsonStr =
            personalData.exams.length > 0
              ? JSON.stringify(personalData.exams)
              : null;
        }

        await db
          .update(subscriptions)
          .set({
            icsContent,
            coursesJson: coursesJsonStr,
            examsJson: examsJsonStr,
            semesterStart: personalData.semesterStart,
            sessionId: personalData.sessionId
              ? String(personalData.sessionId)
              : sub.sessionId,
            sessionName: personalData.sessionName || sub.sessionName,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(eq(subscriptions.id, sub.id));
      } else {
        // Explore subscriptions: CF Worker calls CQU API directly
        try {
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
        } catch (e) {
          console.error(
            `cron: failed to refresh subscription ${sub.sourceName}: ${e}`,
          );
          continue;
        }
      }

      console.log(
        `cron: synced ${sub.sourceName} for ${user.studentId}`,
      );
    } catch (e) {
      console.error(
        `cron: failed to sync ${sub.sourceName}: ${e}`,
      );
    }
  }

  // Update user's last refresh time
  await db
    .update(users)
    .set({ lastRefreshAt: now, updatedAt: now })
    .where(eq(users.id, user.id));
}
