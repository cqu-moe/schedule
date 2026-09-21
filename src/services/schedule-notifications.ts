import { TIME_SLOTS, type CourseEntry, type ExamEntry } from "./cqu-api";
import type { PersonalScheduleData } from "./sync";
import { calculateCourseEventTime } from "../utils/time";

export interface ScheduleSnapshot {
  version: 1;
  semesterStart: string;
  courses: CourseEntry[];
  exams: ExamEntry[];
}

export type ScheduleChangeKind = "added" | "cancelled" | "changed";

export interface ScheduleDetails {
  weekday: string;
  time: string;
  position: string;
  room: string;
  lecturer: string;
  experiment: string;
  seat: string;
}

export interface ScheduleDatePair {
  before?: string;
  after?: string;
}

export interface ScheduleChange {
  kind: ScheduleChangeKind;
  name: string;
  dates: string[];
  extraDates: number;
  datePairs: ScheduleDatePair[];
  beforeDetails?: ScheduleDetails;
  afterDetails?: ScheduleDetails;
  before?: string;
  after?: string;
}

export interface ScheduleDiff {
  courses: ScheduleChange[];
  exams: ScheduleChange[];
  total: number;
}

export interface RenderedScheduleEmail {
  subject: string;
  html: string;
  text: string;
}

export interface ScheduleNotificationMessageV1 {
  version: 1;
  notificationId: string;
  userId: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
}

export function parseScheduleSnapshot(value: string | null): ScheduleSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ScheduleSnapshot>;
    if (
      parsed.version !== 1 ||
      typeof parsed.semesterStart !== "string" ||
      !Array.isArray(parsed.courses) ||
      !Array.isArray(parsed.exams)
    ) return null;
    return parsed as ScheduleSnapshot;
  } catch {
    return null;
  }
}

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

function stableCompare<T>(left: T, right: T): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function normalizeSchedule(data: PersonalScheduleData): ScheduleSnapshot {
  const courses = data.courses.map((item) => ({
    name: clean(item.name),
    lecturer: clean(item.lecturer),
    room: clean(item.room),
    position: clean(item.position),
    day_of_week: item.day_of_week,
    start_session: item.start_session,
    end_session: item.end_session,
    weeks: [...new Set(item.weeks.filter((week) => Number.isInteger(week) && week > 0))]
      .sort((a, b) => a - b),
    ...(clean(item.experiment_name) ? { experiment_name: clean(item.experiment_name) } : {}),
  })).sort(stableCompare);
  const exams = data.exams.map((item) => ({
    name: clean(item.name),
    room: clean(item.room),
    seat: item.seat,
    start_time: clean(item.start_time),
    end_time: clean(item.end_time),
  })).sort(stableCompare);
  return {
    version: 1,
    semesterStart: clean(data.semesterStart),
    courses,
    exams,
  };
}

export async function hashSchedule(snapshot: ScheduleSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface Occurrence {
  name: string;
  groupKey: string;
  start: Date;
  end: Date;
  date: string;
  detail: string;
  summary: string;
  fields: ScheduleDetails;
}

function formatDateTime(start: Date, end: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(start);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const endTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(end);
  return `${value("year")}年${Number(value("month"))}月${Number(value("day"))}日 ${value("weekday")} ${value("hour")}:${value("minute")}–${endTime}`;
}

function formatWeekdayTime(start: Date, end: Date): string {
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
  }).format(start);
  const formatTime = (date: Date) => new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${weekday} ${formatTime(start)}–${formatTime(end)}`;
}

function courseLocation(item: CourseEntry): string {
  const values = [clean(item.position), clean(item.room)].filter(Boolean);
  return [...new Set(values)].join(" · ") || "地点待定";
}

function courseOccurrences(snapshot: ScheduleSnapshot): Occurrence[] {
  const termStart = new Date(snapshot.semesterStart);
  if (Number.isNaN(termStart.getTime())) return [];
  const out: Occurrence[] = [];
  for (const item of snapshot.courses) {
    if (
      item.start_session < 1 || item.start_session > TIME_SLOTS.length ||
      item.end_session < 1 || item.end_session > TIME_SLOTS.length
    ) continue;
    for (const week of item.weeks) {
      const start = calculateCourseEventTime(
        termStart,
        week,
        item.day_of_week,
        TIME_SLOTS[item.start_session - 1][0],
      );
      const end = calculateCourseEventTime(
        termStart,
        week,
        item.day_of_week,
        TIME_SLOTS[item.end_session - 1][1],
      );
      const location = courseLocation(item);
      const lecturer = item.lecturer || "教师待定";
      const detail = `${location} · ${lecturer}${item.experiment_name ? ` · ${item.experiment_name}` : ""}`;
      out.push({
        name: item.name,
        groupKey: `${item.name}\u0000${item.experiment_name ?? ""}\u0000${week}`,
        start,
        end,
        date: formatDateTime(start, end),
        detail,
        fields: {
          weekday: formatWeekdayTime(start, end).split(" ")[0].replace("星期", "周"),
          time: formatWeekdayTime(start, end).split(" ")[1],
          position: item.position,
          room: item.room,
          lecturer,
          experiment: item.experiment_name ?? "",
          seat: "",
        },
        summary: `${formatWeekdayTime(start, end)} · ${detail}`,
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || stableCompare(a, b));
}

function examOccurrences(snapshot: ScheduleSnapshot): Occurrence[] {
  return snapshot.exams.flatMap((item) => {
    const start = new Date(item.start_time);
    const end = new Date(item.end_time);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    const detail = `${item.room || "地点待定"}${item.seat > 0 ? ` · 座位 ${item.seat}` : ""}`;
    return [{
      name: item.name,
      groupKey: item.name,
      start,
      end,
      date: formatDateTime(start, end),
      detail,
      fields: {
        weekday: formatWeekdayTime(start, end).split(" ")[0].replace("星期", "周"),
        time: formatWeekdayTime(start, end).split(" ")[1],
        position: "",
        room: item.room || "地点待定",
        lecturer: "",
        experiment: "",
        seat: item.seat > 0 ? `${item.seat}号` : "",
      },
      summary: `${formatWeekdayTime(start, end)} · ${detail}`,
    }];
  }).sort((a, b) => a.start.getTime() - b.start.getTime() || stableCompare(a, b));
}

interface RawChange {
  datePair: ScheduleDatePair;
  beforeDetails?: ScheduleDetails;
  afterDetails?: ScheduleDetails;
  kind: ScheduleChangeKind;
  name: string;
  date: string;
  before?: string;
  after?: string;
}

function pairOccurrences(oldItems: Occurrence[], newItems: Occurrence[], now: Date): RawChange[] {
  const groups = new Set([...oldItems.map((item) => item.groupKey), ...newItems.map((item) => item.groupKey)]);
  const changes: RawChange[] = [];
  for (const key of groups) {
    const before = oldItems.filter((item) => item.groupKey === key);
    const after = newItems.filter((item) => item.groupKey === key);
    const unmatchedBefore = [...before];
    const unmatchedAfter = [...after];

    for (let oldIndex = unmatchedBefore.length - 1; oldIndex >= 0; oldIndex -= 1) {
      const oldItem = unmatchedBefore[oldIndex];
      const exactIndex = unmatchedAfter.findIndex((newItem) =>
        oldItem.start.getTime() === newItem.start.getTime()
        && oldItem.end.getTime() === newItem.end.getTime()
        && JSON.stringify(oldItem.fields) === JSON.stringify(newItem.fields));
      if (exactIndex >= 0) {
        unmatchedBefore.splice(oldIndex, 1);
        unmatchedAfter.splice(exactIndex, 1);
      }
    }

    while (unmatchedBefore.length > 0 && unmatchedAfter.length > 0) {
      let bestOldIndex = 0;
      let bestNewIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let oldIndex = 0; oldIndex < unmatchedBefore.length; oldIndex += 1) {
        for (let newIndex = 0; newIndex < unmatchedAfter.length; newIndex += 1) {
          const distance = Math.abs(
            unmatchedBefore[oldIndex].start.getTime() - unmatchedAfter[newIndex].start.getTime(),
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            bestOldIndex = oldIndex;
            bestNewIndex = newIndex;
          }
        }
      }
      const [oldItem] = unmatchedBefore.splice(bestOldIndex, 1);
      const [newItem] = unmatchedAfter.splice(bestNewIndex, 1);
      if (oldItem.end > now || newItem.end > now) {
        const date = oldItem.start.getTime() === newItem.start.getTime()
          && oldItem.end.getTime() === newItem.end.getTime()
          ? newItem.date
          : `${oldItem.date} → ${newItem.date}`;
        changes.push({
          kind: "changed",
          name: newItem.name,
          date,
          datePair: { before: oldItem.start.toISOString(), after: newItem.start.toISOString() },
          beforeDetails: oldItem.fields,
          afterDetails: newItem.fields,
          before: oldItem.summary,
          after: newItem.summary,
        });
      }
    }

    for (const newItem of unmatchedAfter) {
      if (newItem.end > now) {
        changes.push({ kind: "added", name: newItem.name, date: newItem.date, after: newItem.summary, datePair: { after: newItem.start.toISOString() }, afterDetails: newItem.fields });
      }
    }
    for (const oldItem of unmatchedBefore) {
      if (oldItem.end > now) {
        changes.push({ kind: "cancelled", name: oldItem.name, date: oldItem.date, before: oldItem.summary, datePair: { before: oldItem.start.toISOString() }, beforeDetails: oldItem.fields });
      }
    }
  }
  return changes;
}

function groupChanges(changes: RawChange[]): ScheduleChange[] {
  const grouped = new Map<string, ScheduleChange>();
  for (const change of changes) {
    const key = JSON.stringify([change.kind, change.name, change.beforeDetails, change.afterDetails]);
    const current = grouped.get(key);
    if (current) {
      current.dates.push(change.date);
      current.datePairs.push(change.datePair);
    } else {
      grouped.set(key, {
        kind: change.kind,
        name: change.name,
        dates: [change.date],
        extraDates: 0,
        datePairs: [change.datePair],
        before: change.before,
        after: change.after,
        beforeDetails: change.beforeDetails,
        afterDetails: change.afterDetails,
      });
    }
  }
  return [...grouped.values()];
}

export function diffFutureSchedule(
  oldSnapshot: ScheduleSnapshot,
  newSnapshot: ScheduleSnapshot,
  now = new Date(),
): ScheduleDiff {
  const courses = groupChanges(pairOccurrences(
    courseOccurrences(oldSnapshot),
    courseOccurrences(newSnapshot),
    now,
  ));
  const exams = groupChanges(pairOccurrences(
    examOccurrences(oldSnapshot),
    examOccurrences(newSnapshot),
    now,
  ));
  return { courses, exams, total: courses.length + exams.length };
}

export { renderScheduleChangeEmail, createScheduleNotificationMessages } from "./schedule-email";

export async function createNotificationId(
  userId: string,
  oldHash: string,
  newHash: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`1\u0000${userId}\u0000${oldHash}\u0000${newHash}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `schedule-v1-${hash}`;
}
