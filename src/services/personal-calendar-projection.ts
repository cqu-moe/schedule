import type { CourseEntry, ExamEntry } from "./cqu-api";
import type { PersonalViewType, Subscription } from "../db/schema";
import {
  EMPTY_ICS,
  generateCoursesIcs,
  generateExamsIcs,
  mergeIcs,
} from "./ics";

function parseArray<T>(raw: string | null): T[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as T[];
  } catch {
    throw new Error("PERSONAL_CALENDAR_DATA_CORRUPTED");
  }
}

export function projectPersonalCalendar(
  sub: Subscription,
  view: PersonalViewType,
): { icsContent: string; coursesJson: string | null; examsJson: string | null } {
  const courses = parseArray<CourseEntry>(sub.coursesJson);
  const exams = parseArray<ExamEntry>(sub.examsJson);
  const selectedCourses = view === "personal_exams" ? [] : courses;
  const selectedExams = view === "personal_courses" ? [] : exams;
  const coursesIcs = generateCoursesIcs(
    selectedCourses,
    sub.semesterStart ?? "",
    sub.sourceId,
  );
  const examsIcs = selectedExams.length > 0
    ? generateExamsIcs(selectedExams, sub.sourceId)
    : EMPTY_ICS;
  const icsContent = view === "personal_courses"
    ? coursesIcs
    : view === "personal_exams"
      ? examsIcs
      : mergeIcs(coursesIcs, examsIcs);

  return {
    icsContent,
    coursesJson: view === "personal_exams" ? null : JSON.stringify(selectedCourses),
    examsJson: view === "personal_courses" ? null : JSON.stringify(selectedExams),
  };
}
