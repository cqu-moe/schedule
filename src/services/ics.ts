import { TIME_SLOTS, type CourseEntry, type ExamEntry } from "./cqu-api";
import { calculateCourseEventTime } from "../utils/time";

const ICS_HEADER = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//CQU Schedule//CN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
].join("\r\n");

const ICS_FOOTER = "END:VCALENDAR";

export const EMPTY_ICS = [ICS_HEADER, ICS_FOOTER].join("\r\n");

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

function formatIcsTime(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

function generateUid(
  username: string,
  summary: string,
  start: string,
  end: string,
): string {
  const source = `${username},${summary},${start},${end}`;
  // Two FNV-1a 32-bit hashes with different seeds, concatenated for adequate uniqueness.
  // NOTE: This replaced SHA-256 for performance. UIDs differ from previous versions,
  // causing a one-time calendar event re-creation for existing subscribers.
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"));
}

export function generateCoursesIcs(
  courses: CourseEntry[],
  semesterStart: string,
  username: string,
): string {
  const termStart = new Date(semesterStart);
  if (isNaN(termStart.getTime())) {
    return [ICS_HEADER, ICS_FOOTER].join("\r\n");
  }
  const lines: string[] = [ICS_HEADER];

  for (const course of courses) {
    for (const week of course.weeks) {
      if (course.start_session < 1 || course.start_session > TIME_SLOTS.length ||
          course.end_session < 1 || course.end_session > TIME_SLOTS.length) {
        continue;
      }
      const startTime = calculateCourseEventTime(
        termStart,
        week,
        course.day_of_week,
        TIME_SLOTS[course.start_session - 1][0],
      );
      const endTime = calculateCourseEventTime(
        termStart,
        week,
        course.day_of_week,
        TIME_SLOTS[course.end_session - 1][1],
      );

      const startStr = formatIcsTime(startTime);
      const endStr = formatIcsTime(endTime);
      const uid = generateUid(username, course.name, startStr, endStr);
      const location = course.room || course.position;
      const description = course.experiment_name
        ? `教师：${course.lecturer}\n实验内容：${course.experiment_name}`
        : `教师：${course.lecturer}`;

      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTART:${startStr}`,
        `DTEND:${endStr}`,
        `SUMMARY:${escapeIcsText(course.name)}`,
        `LOCATION:${escapeIcsText(location)}`,
        `DESCRIPTION:${escapeIcsText(description)}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT15M",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(course.name)}`,
        "END:VALARM",
        "END:VEVENT",
      );
    }
  }

  lines.push(ICS_FOOTER);
  return lines.join("\r\n");
}

export function generateExamsIcs(
  exams: ExamEntry[],
  username: string,
): string {
  const lines: string[] = [ICS_HEADER];

  for (const exam of exams) {
    const startTime = new Date(exam.start_time);
    const endTime = new Date(exam.end_time);

    const startStr = formatIcsTime(startTime);
    const endStr = formatIcsTime(endTime);
    const uid = generateUid(username, exam.name, startStr, endStr);
    const description = exam.seat > 0 ? `座位: ${exam.seat}` : "";
    const location = exam.seat > 0 ? `${exam.room}@${exam.seat}` : exam.room;

    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTART:${startStr}`,
      `DTEND:${endStr}`,
      `SUMMARY:${escapeIcsText(exam.name)}`,
      `LOCATION:${escapeIcsText(location)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT1H",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(exam.name)}`,
      "END:VALARM",
      "END:VEVENT",
    );
  }

  lines.push(ICS_FOOTER);
  return lines.join("\r\n");
}

export function mergeIcs(coursesIcs: string, examsIcs: string): string {
  const eventRegex = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
  const courseEvents = coursesIcs.match(eventRegex) ?? [];
  const examEvents = examsIcs.match(eventRegex) ?? [];

  const lines: string[] = [ICS_HEADER, ...courseEvents, ...examEvents, ICS_FOOTER];
  return lines.join("\r\n");
}
