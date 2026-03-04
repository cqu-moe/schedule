import { TIME_SLOTS, type CourseEntry, type ExamEntry } from "./cqu-api";
import { bufferToBase64 } from "../utils/encoding";

const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

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
    .replace(/\n/g, "\\n");
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

async function generateUid(
  username: string,
  summary: string,
  start: string,
  end: string,
): Promise<string> {
  const source = `${username},${summary},${start},${end}`;
  const encoded = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToBase64(hash);
}

function calculateEventTime(
  termStart: Date,
  week: number,
  dayOfWeek: number,
  session: number,
  isStart: boolean,
): Date {
  const daysSinceStart = (week - 1) * 7 + (dayOfWeek - 1);
  const eventDateMs =
    termStart.getTime() + daysSinceStart * 24 * 60 * 60 * 1000;
  const eventDate = new Date(eventDateMs);

  if (session < 1 || session > TIME_SLOTS.length) {
    throw new Error(`Invalid session number: ${session}`);
  }
  const timeStr = TIME_SLOTS[session - 1][isStart ? 0 : 1];
  const [h, m, s] = timeStr.split(":").map(Number);

  // Build China local time, then convert to UTC
  const chinaMs =
    Date.UTC(
      eventDate.getUTCFullYear(),
      eventDate.getUTCMonth(),
      eventDate.getUTCDate(),
      h,
      m,
      s,
    ) - CHINA_TZ_OFFSET_MS;

  return new Date(chinaMs);
}

export async function generateCoursesIcs(
  courses: CourseEntry[],
  semesterStart: string,
  username: string,
): Promise<string> {
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
      const startTime = calculateEventTime(
        termStart,
        week,
        course.day_of_week,
        course.start_session,
        true,
      );
      const endTime = calculateEventTime(
        termStart,
        week,
        course.day_of_week,
        course.end_session,
        false,
      );

      const startStr = formatIcsTime(startTime);
      const endStr = formatIcsTime(endTime);
      const uid = await generateUid(username, course.name, startStr, endStr);
      const location = course.room || course.position;

      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTART:${startStr}`,
        `DTEND:${endStr}`,
        `SUMMARY:${escapeIcsText(course.name)}`,
        `LOCATION:${escapeIcsText(location)}`,
        `DESCRIPTION:${escapeIcsText(`教师：${course.lecturer}`)}`,
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

export async function generateExamsIcs(
  exams: ExamEntry[],
  username: string,
): Promise<string> {
  const lines: string[] = [ICS_HEADER];

  for (const exam of exams) {
    const startTime = new Date(exam.start_time);
    const endTime = new Date(exam.end_time);

    const startStr = formatIcsTime(startTime);
    const endStr = formatIcsTime(endTime);
    const uid = await generateUid(username, exam.name, startStr, endStr);
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
