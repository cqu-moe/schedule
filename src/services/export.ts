import { TIME_SLOTS, type CourseEntry, type ExamEntry } from "./cqu-api";
import { calculateCourseEventTime, formatChinaIso } from "../utils/time";

const SEMESTER_RE = /^(\d{4})-(\d{4})学年第(一|二)学期$/;

const CSV_FIELDS = [
  "name",
  "type",
  "instructor",
  "location",
  "day_of_week",
  "start_time",
  "end_time",
  "week",
] as const;

export interface FormattedEvent {
  name: string;
  type: "course" | "exam";
  instructor: string | null;
  location: string;
  day_of_week: number | null;
  start_time: string;
  end_time: string;
  week: number | null;
}

export function semesterShortName(sessionName: string | null): string {
  if (!sessionName) return "";
  const match = SEMESTER_RE.exec(sessionName);
  if (!match) return sessionName;
  const [, year1, year2, ordinal] = match;
  return ordinal === "一" ? `${year1}秋` : `${year2}春`;
}

export function generateFormattedEvents(
  coursesJson: CourseEntry[] | null,
  semesterStart: string,
  examsJson?: ExamEntry[] | null,
): FormattedEvent[] {
  const events: FormattedEvent[] = [];

  if (coursesJson && semesterStart) {
    const termStart = new Date(semesterStart);
    if (!isNaN(termStart.getTime())) {
      for (const course of coursesJson) {
        try {
          const name: string = course.name ?? "";
          const instructor: string = course.lecturer ?? "";
          const room: string = course.room ?? "";
          const position: string = course.position ?? "";
          const location = room || position;
          const dayOfWeek: number = course.day_of_week;
          const startSession: number = course.start_session;
          const endSession: number = course.end_session;
          const weeks: number[] = course.weeks ?? [];

          if (
            startSession < 1 ||
            startSession > TIME_SLOTS.length ||
            endSession < 1 ||
            endSession > TIME_SLOTS.length
          ) {
            continue;
          }

          const startTimeStr = TIME_SLOTS[startSession - 1][0];
          const endTimeStr = TIME_SLOTS[endSession - 1][1];

          for (const week of weeks) {
            const startDate = calculateCourseEventTime(termStart, week, dayOfWeek, startTimeStr);
            const endDate = calculateCourseEventTime(termStart, week, dayOfWeek, endTimeStr);

            events.push({
              name,
              type: "course",
              instructor,
              location,
              day_of_week: dayOfWeek,
              start_time: formatChinaIso(startDate),
              end_time: formatChinaIso(endDate),
              week,
            });
          }
        } catch {
          continue;
        }
      }
    }
  }

  if (examsJson) {
    for (const exam of examsJson) {
      try {
        const name: string = exam.name;
        const room: string = exam.room ?? "";
        const seat: number = exam.seat ?? 0;
        const location = seat ? `${room} 座位${seat}` : room;
        const startTime: string = exam.start_time;
        const endTime: string = exam.end_time;

        // Validate datetime strings
        if (isNaN(new Date(startTime).getTime())) continue;
        if (isNaN(new Date(endTime).getTime())) continue;

        events.push({
          name,
          type: "exam",
          instructor: null,
          location,
          day_of_week: null,
          start_time: startTime,
          end_time: endTime,
          week: null,
        });
      } catch {
        continue;
      }
    }
  }

  return events;
}

function sanitizeCsvValue(value: string): string {
  if (
    value &&
    (value[0] === "=" ||
      value[0] === "+" ||
      value[0] === "-" ||
      value[0] === "@")
  ) {
    return `'${value}`;
  }
  return value;
}

function escapeCsvField(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  const sanitized = sanitizeCsvValue(str);
  if (
    sanitized.includes(",") ||
    sanitized.includes('"') ||
    sanitized.includes("\n") ||
    sanitized.includes("\r")
  ) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

export function generateCsv(events: FormattedEvent[]): string {
  const BOM = "\ufeff";
  const lines: string[] = [CSV_FIELDS.join(",")];

  for (const event of events) {
    const row = CSV_FIELDS.map((field) => escapeCsvField(event[field]));
    lines.push(row.join(","));
  }

  return BOM + lines.join("\r\n");
}

