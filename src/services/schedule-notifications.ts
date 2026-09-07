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

export interface ScheduleChange {
  kind: ScheduleChangeKind;
  name: string;
  dates: string[];
  extraDates: number;
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

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

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
      const location = item.room || item.position || "地点待定";
      const lecturer = item.lecturer || "教师待定";
      out.push({
        name: item.name,
        groupKey: `${item.name}\u0000${item.experiment_name ?? ""}\u0000${week}`,
        start,
        end,
        date: formatDateTime(start, end),
        detail: `${location} · ${lecturer}${item.experiment_name ? ` · ${item.experiment_name}` : ""}`,
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
    return [{
      name: item.name,
      groupKey: item.name,
      start,
      end,
      date: formatDateTime(start, end),
      detail: `${item.room || "地点待定"}${item.seat > 0 ? ` · 座位 ${item.seat}` : ""}`,
    }];
  }).sort((a, b) => a.start.getTime() - b.start.getTime() || stableCompare(a, b));
}

interface RawChange {
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
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count; index += 1) {
      const oldItem = before[index];
      const newItem = after[index];
      if (oldItem && newItem) {
        const unchanged = oldItem.start.getTime() === newItem.start.getTime()
          && oldItem.end.getTime() === newItem.end.getTime()
          && oldItem.detail === newItem.detail;
        if (!unchanged && (oldItem.end > now || newItem.end > now)) {
          changes.push({
            kind: "changed",
            name: newItem.name,
            date: newItem.end > now ? newItem.date : oldItem.date,
            before: `${oldItem.date} · ${oldItem.detail}`,
            after: `${newItem.date} · ${newItem.detail}`,
          });
        }
      } else if (newItem && newItem.end > now) {
        changes.push({ kind: "added", name: newItem.name, date: newItem.date, after: newItem.detail });
      } else if (oldItem && oldItem.end > now) {
        changes.push({ kind: "cancelled", name: oldItem.name, date: oldItem.date, before: oldItem.detail });
      }
    }
  }
  return changes;
}

function groupChanges(changes: RawChange[]): ScheduleChange[] {
  const grouped = new Map<string, { change: RawChange; dates: string[] }>();
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.name}\u0000${change.before ?? ""}\u0000${change.after ?? ""}`;
    const current = grouped.get(key);
    if (current) current.dates.push(change.date);
    else grouped.set(key, { change, dates: [change.date] });
  }
  return [...grouped.values()].map(({ change, dates }) => ({
    kind: change.kind,
    name: change.name,
    dates: dates.slice(0, 5),
    extraDates: Math.max(0, dates.length - 5),
    ...(change.before ? { before: change.before } : {}),
    ...(change.after ? { after: change.after } : {}),
  }));
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_LABEL: Record<ScheduleChangeKind, string> = {
  added: "新增",
  cancelled: "取消",
  changed: "调整",
};

function renderHtmlSection(title: string, changes: ScheduleChange[]): string {
  if (changes.length === 0) return "";
  const rows = changes.map((change) => {
    const dates = change.dates.map((date) => `<div style="font-size:16px;line-height:1.5;color:#111827;">${escapeHtml(date)}</div>`).join("");
    const extra = change.extraDates > 0
      ? `<div style="font-size:14px;line-height:1.5;color:#6b7280;">另有 ${change.extraDates} 个日期</div>`
      : "";
    const details = change.kind === "changed"
      ? `<div style="margin-top:4px;color:#6b7280;">原：${escapeHtml(change.before ?? "")}</div><div style="color:#374151;">现：${escapeHtml(change.after ?? "")}</div>`
      : `<div style="margin-top:4px;color:#6b7280;">${escapeHtml(change.after ?? change.before ?? "")}</div>`;
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;font-size:15px;line-height:1.55;"><div style="margin-bottom:2px;color:#111827;font-size:16px;font-weight:500;">${escapeHtml(change.name)} <span style="font-size:13px;font-weight:400;color:#6b7280;">${KIND_LABEL[change.kind]}</span></div>${dates}${extra}${details}</td></tr>`;
  }).join("");
  return `<tr><td style="padding:20px 0 4px;font-size:17px;font-weight:600;color:#111827;">${title}</td></tr>${rows}`;
}

function renderTextSection(title: string, changes: ScheduleChange[]): string {
  if (changes.length === 0) return "";
  const lines = changes.flatMap((change) => [
    `${change.name} · ${KIND_LABEL[change.kind]}`,
    ...change.dates,
    ...(change.extraDates > 0 ? [`另有 ${change.extraDates} 个日期`] : []),
    ...(change.kind === "changed"
      ? [`原：${change.before ?? ""}`, `现：${change.after ?? ""}`]
      : [change.after ?? change.before ?? ""]),
    "",
  ]);
  return `${title}\n${lines.join("\n")}`.trimEnd();
}

export function renderScheduleChangeEmail(diff: ScheduleDiff): RenderedScheduleEmail {
  const subject = `课表与考试安排有更新（${diff.total}项）`;
  const html = `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f5f5f4;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e5e7eb;"><tr><td style="padding:24px 28px 8px;"><div style="font-size:24px;line-height:1.3;font-weight:600;">课表有更新</div><div style="margin-top:8px;font-size:15px;line-height:1.6;color:#4b5563;">本次同步发现 ${diff.total} 项未来安排变化，课程与考试已合并列出。</div></td></tr><tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${renderHtmlSection("课程表", diff.courses)}${renderHtmlSection("考试安排", diff.exams)}</table></td></tr><tr><td style="padding:22px 28px 10px;"><a href="https://schedule.cqu.moe/" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;font-size:15px;line-height:1;border-radius:5px;">查看最新课表</a></td></tr><tr><td style="padding:12px 28px 24px;font-size:13px;line-height:1.6;color:#6b7280;">仅通知同步时尚未结束的安排。<a href="https://schedule.cqu.moe/#notification-settings" style="color:#4b5563;">管理通知设置</a></td></tr></table></td></tr></table></body></html>`;
  const text = [
    "课表有更新",
    `本次同步发现 ${diff.total} 项未来安排变化。`,
    "",
    renderTextSection("课程表", diff.courses),
    renderTextSection("考试安排", diff.exams),
    "",
    "查看最新课表：https://schedule.cqu.moe/",
    "管理通知设置：https://schedule.cqu.moe/#notification-settings",
  ].filter((line, index, array) => line !== "" || array[index - 1] !== "").join("\n");
  return { subject, html, text };
}

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
