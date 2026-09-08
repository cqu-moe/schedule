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
      summary: `${formatWeekdayTime(start, end)} · ${detail}`,
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
    const unmatchedBefore = [...before];
    const unmatchedAfter = [...after];

    for (let oldIndex = unmatchedBefore.length - 1; oldIndex >= 0; oldIndex -= 1) {
      const oldItem = unmatchedBefore[oldIndex];
      const exactIndex = unmatchedAfter.findIndex((newItem) =>
        oldItem.start.getTime() === newItem.start.getTime()
        && oldItem.end.getTime() === newItem.end.getTime()
        && oldItem.detail === newItem.detail);
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
          before: oldItem.summary,
          after: newItem.summary,
        });
      }
    }

    for (const newItem of unmatchedAfter) {
      if (newItem.end > now) {
        changes.push({ kind: "added", name: newItem.name, date: newItem.date, after: newItem.summary });
      }
    }
    for (const oldItem of unmatchedBefore) {
      if (oldItem.end > now) {
        changes.push({ kind: "cancelled", name: oldItem.name, date: oldItem.date, before: oldItem.summary });
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

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
const EMAIL_DARK_CSS = "@media(prefers-color-scheme:dark){.email-body,.email-page,.email-card,.email-surface{background:#1c1c1c!important}.email-primary{color:#eeeeec!important}.email-secondary,.email-accent{color:#c9c9c5!important}.email-muted{color:#a3a39e!important}.email-row,.email-footer{border-color:#3b3b38!important}.email-diff-add{background:#163522!important;color:#aff5b4!important}.email-diff-remove{background:#3d2024!important;color:#ffdcd7!important}}[data-ogsc] .email-page,[data-ogsc] .email-card,[data-ogsc] .email-surface{background:#1c1c1c!important}[data-ogsc] .email-primary{color:#eeeeec!important}[data-ogsc] .email-secondary,[data-ogsc] .email-accent{color:#c9c9c5!important}[data-ogsc] .email-muted{color:#a3a39e!important}[data-ogsc] .email-row,[data-ogsc] .email-footer{border-color:#3b3b38!important}[data-ogsc] .email-diff-add{background:#163522!important;color:#aff5b4!important}[data-ogsc] .email-diff-remove{background:#3d2024!important;color:#ffdcd7!important}";

interface EmailDate {
  monthDay: string;
  yearWeekday: string;
  time: string;
}

function emailDate(value: string): EmailDate {
  const current = value.split(" → ").at(-1)?.trim() ?? value;
  const match = current.match(/^(\d{4})年(\d+)月(\d+)日 星期([一二三四五六日]) (.+)$/);
  if (!match) return { monthDay: current, yearWeekday: "", time: "" };
  return {
    monthDay: `${Number(match[2])} 月 ${Number(match[3])} 日`,
    yearWeekday: `${match[1]} 年 · 周${match[4]}`,
    time: match[5],
  };
}

function changeLabel(section: "course" | "exam", change: ScheduleChange): string {
  if (change.kind === "added") return section === "exam" ? "新增考试" : "新增课程";
  if (change.kind === "cancelled") return section === "exam" ? "考试取消" : "课程取消";

  const before = (change.before ?? "").split(" · ");
  const after = (change.after ?? "").split(" · ");
  if (before[0] !== after[0] || change.dates.some((date) => date.includes(" → "))) return "时间调整";
  if (section === "course") {
    const beforeLocation = before.slice(1, Math.max(2, before.length - 1)).join(" · ");
    const afterLocation = after.slice(1, Math.max(2, after.length - 1)).join(" · ");
    if (beforeLocation !== afterLocation) return "地点调整";
  } else if (before[1] !== after[1]) {
    return "地点调整";
  }
  return "信息调整";
}

function renderChangeDetails(change: ScheduleChange): string {
  const row = (value: string, added: boolean): string => {
    const color = added ? "#1a5930" : "#842b2e";
    const background = added ? "#dafbe1" : "#ffebe9";
    const className = added ? "email-diff-add" : "email-diff-remove";
    return `<tr><td class="${className}" width="28" valign="top" bgcolor="${background}" style="width:28px;padding:7px 0 7px 10px;background:${background};color:${color};font-family:Consolas,Menlo,monospace;font-size:15px;line-height:22px;">${added ? "+" : "−"}</td><td class="${className}" bgcolor="${background}" style="padding:7px 12px 7px 0;background:${background};color:${color};font-family:${EMAIL_FONT};font-size:15px;line-height:22px;overflow-wrap:anywhere;word-break:break-word;"><span style="font-size:13px;">${added ? "现" : "原"}：</span>${escapeHtml(value)}</td></tr>`;
  };
  const rows = change.kind === "changed"
    ? row(change.before ?? "", false) + row(change.after ?? "", true)
    : row(change.after ?? change.before ?? "", change.kind === "added");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:12px;width:100%;table-layout:fixed;">${rows}</table>`;
}

function renderHtmlSection(
  title: string,
  section: "course" | "exam",
  changes: ScheduleChange[],
  topPadding: number,
): string {
  if (changes.length === 0) return "";
  const rows = changes.map((change) => {
    const dates = change.dates.map((value) => {
      if (value.includes(" → ")) return escapeHtml(value);
      const date = emailDate(value);
      return escapeHtml(date.yearWeekday ? `${date.monthDay} · ${date.yearWeekday}` : value);
    }).join("<br>");
    const extra = change.extraDates > 0 ? `<br>另有 ${change.extraDates} 个日期` : "";
    return `<tr><td class="email-row" style="padding:16px 0 20px;overflow-wrap:anywhere;word-break:break-word;"><h3 class="email-primary" style="margin:0;font-family:${EMAIL_FONT};font-size:17px;line-height:26px;font-weight:600;color:#242421;">${escapeHtml(change.name)}<span class="email-secondary" style="font-size:14px;font-weight:400;color:#50504b;"> · ${changeLabel(section, change)}</span></h3><p class="email-muted" style="margin:5px 0 0;font-family:${EMAIL_FONT};font-size:14px;line-height:23px;color:#71716b;">${dates || "日期待定"}${extra}</p>${renderChangeDetails(change)}</td></tr>`;
  }).join("");
  return `<tr><td class="pad email-surface" bgcolor="#ffffff" style="padding:${topPadding}px 32px 0;background:#ffffff;"><h2 class="email-secondary" style="margin:0;font-family:${EMAIL_FONT};font-size:14px;line-height:22px;font-weight:400;color:#50504b;">${title} · ${changes.length} 项</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed;width:100%;">${rows}</table></td></tr>`;
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

function formatSyncTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")} 年 ${Number(value("month"))} 月 ${Number(value("day"))} 日 ${value("hour")}:${value("minute")}`;
}

export function renderScheduleChangeEmail(diff: ScheduleDiff, syncedAt = new Date()): RenderedScheduleEmail {
  const subject = `课表与考试安排有更新（${diff.total}项）`;
  const preheader = `课程表 ${diff.courses.length} 处、考试安排 ${diff.exams.length} 处，均为未来时间的变化。`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>:root{color-scheme:light dark;supported-color-schemes:light dark}${EMAIL_DARK_CSS}@media only screen and (max-width:640px){.pad{padding-left:24px!important;padding-right:24px!important}.email-top{padding-top:28px!important}}</style></head>
<body class="email-body" bgcolor="#ffffff" style="margin:0;padding:0;background:#ffffff;color:#242421;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${preheader}</div>
<table class="email-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff"><tr><td align="center">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table class="email-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;">
<tr><td class="pad email-surface email-top" style="padding:48px 32px 30px;">
<p class="email-muted" style="margin:0 0 24px;font-family:${EMAIL_FONT};font-size:13px;line-height:21px;color:#71716b;">CQU.MOE / 重庆大学课表</p>
<h1 class="email-primary" style="margin:0;font-family:${EMAIL_FONT};font-size:26px;line-height:36px;font-weight:600;color:#242421;">课表有更新</h1>
<p class="email-secondary" style="margin:10px 0 0;font-family:${EMAIL_FONT};font-size:15px;line-height:25px;color:#50504b;">有 ${diff.total} 项安排变更，请留意上课或考试时间与地点。</p>
</td></tr>
${renderHtmlSection("课程表", "course", diff.courses, 0)}
${renderHtmlSection("考试安排", "exam", diff.exams, diff.courses.length > 0 ? 28 : 0)}
<tr><td class="pad email-surface" style="padding:24px 32px 28px;"><a class="email-accent" href="https://schedule.cqu.moe/" style="display:inline-block;padding:10px 0;font-family:${EMAIL_FONT};font-size:15px;line-height:24px;font-weight:500;color:#242421;text-decoration:underline;text-underline-offset:4px;">查看最新课表</a></td></tr>
<tr><td class="pad email-surface" style="padding:0 32px 40px;">
<p class="email-muted" style="margin:0;font-family:${EMAIL_FONT};font-size:12px;line-height:21px;color:#71716b;">同步于 ${formatSyncTime(syncedAt)}（北京时间）</p>
<p class="email-muted" style="margin:4px 0 0;font-family:${EMAIL_FONT};font-size:12px;line-height:21px;color:#71716b;">你已开启课表变更通知 · <a class="email-muted" href="https://schedule.cqu.moe/#notification-settings" style="display:inline-block;padding:5px 0;color:#71716b;text-decoration:underline;">管理通知设置</a></p>
<p class="email-muted" style="margin:10px 0 0;font-family:${EMAIL_FONT};font-size:12px;line-height:21px;color:#71716b;">CQU.MOE 是学生维护的非官方服务。安排请以学校系统为准。</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
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
