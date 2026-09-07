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
const EMAIL_DARK_CSS = "@media(prefers-color-scheme:dark){.email-body,.email-page{background:#15191c!important}.email-card,.email-surface{background:#1d2226!important}.email-footer{background:#192025!important}.email-primary{color:#edf2f5!important}.email-secondary{color:#bac4ca!important}.email-muted{color:#93a0a9!important}.email-brand,.email-accent{color:#77b4df!important}.email-section{color:#dfe8ed!important;border-color:#7f949f!important}.email-row,.email-header,.email-footer{border-color:#364149!important}.email-button{background:#2b75a8!important;color:#fff!important}.email-danger{color:#e29a91!important}.email-success{color:#8fc2a7!important}.email-strike{color:#8c989f!important}}[data-ogsc] .email-page{background:#15191c!important}[data-ogsc] .email-card,[data-ogsc] .email-surface{background:#1d2226!important}[data-ogsc] .email-footer{background:#192025!important}[data-ogsc] .email-primary{color:#edf2f5!important}[data-ogsc] .email-secondary{color:#bac4ca!important}[data-ogsc] .email-muted{color:#93a0a9!important}[data-ogsc] .email-brand,[data-ogsc] .email-accent{color:#77b4df!important}[data-ogsc] .email-section{color:#dfe8ed!important;border-color:#7f949f!important}[data-ogsc] .email-row,[data-ogsc] .email-header,[data-ogsc] .email-footer{border-color:#364149!important}[data-ogsc] .email-button{background:#2b75a8!important;color:#fff!important}[data-ogsc] .email-danger{color:#e29a91!important}[data-ogsc] .email-success{color:#8fc2a7!important}[data-ogsc] .email-strike{color:#8c989f!important}";

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

function compactAffectedDates(change: ScheduleChange): string {
  if (change.dates.length <= 1 && change.extraDates === 0) return "";
  const dates = change.dates.map((date) => emailDate(date).monthDay).join("、");
  const extra = change.extraDates > 0 ? `，另有 ${change.extraDates} 个日期` : "";
  return `<div class="email-muted" style="margin-top:5px;font-family:${EMAIL_FONT};font-size:13px;line-height:19px;color:#64727c;">影响日期：${escapeHtml(dates)}${extra}</div>`;
}

function renderChangeDetails(change: ScheduleChange, date: EmailDate): string {
  if (change.kind === "changed") {
    return `<div class="email-strike" style="margin-top:6px;font-family:${EMAIL_FONT};font-size:15px;line-height:22px;color:#6c7982;text-decoration:line-through;">原：${escapeHtml(change.before ?? "")}</div><div class="email-secondary" style="font-family:${EMAIL_FONT};font-size:15px;line-height:22px;color:#273844;">现：${escapeHtml(change.after ?? "")}</div>${compactAffectedDates(change)}`;
  }
  const detail = change.after ?? change.before ?? "";
  const value = detail || date.time;
  return `<div class="email-secondary" style="margin-top:6px;font-family:${EMAIL_FONT};font-size:15px;line-height:22px;color:#273844;">${escapeHtml(value)}</div>${compactAffectedDates(change)}`;
}

function renderHtmlSection(
  title: string,
  section: "course" | "exam",
  changes: ScheduleChange[],
  topPadding: number,
): string {
  if (changes.length === 0) return "";
  const rows = changes.map((change, index) => {
    const date = emailDate(change.dates[0] ?? "日期待定");
    const border = index === changes.length - 1 ? "" : "border-bottom:1px solid #e7eaed;";
    const labelColor = change.kind === "cancelled"
      ? "#9a443c"
      : change.kind === "added"
        ? "#3f715c"
        : "#174f78";
    const labelClass = change.kind === "cancelled"
      ? "email-danger"
      : change.kind === "added"
        ? "email-success"
        : "email-accent";
    return `<tr><td class="date-col email-row" width="104" valign="top" style="width:104px;padding:13px 14px 13px 0;${border}"><div class="email-primary" style="font-family:${EMAIL_FONT};font-size:16px;line-height:22px;font-weight:700;color:#1d252c;">${escapeHtml(date.monthDay)}</div>${date.yearWeekday ? `<div class="email-muted" style="margin-top:2px;font-family:${EMAIL_FONT};font-size:13px;line-height:19px;color:#64727c;">${escapeHtml(date.yearWeekday)}</div>` : ""}</td><td class="detail-col email-row" valign="top" style="padding:13px 0;${border}"><div class="email-primary" style="font-family:${EMAIL_FONT};font-size:16px;line-height:23px;font-weight:700;color:#1d252c;">${escapeHtml(change.name)}</div><div class="${labelClass}" style="margin-top:2px;font-family:${EMAIL_FONT};font-size:13px;line-height:19px;color:${labelColor};">${changeLabel(section, change)}</div>${renderChangeDetails(change, date)}</td></tr>`;
  }).join("");
  return `<tr><td class="pad email-surface" bgcolor="#ffffff" style="padding:${topPadding}px 32px 0;background:#ffffff;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="email-section" style="padding:0 0 7px;border-bottom:2px solid #273844;font-family:${EMAIL_FONT};font-size:16px;line-height:23px;font-weight:700;color:#273844;">${title} <span class="email-muted" style="font-size:13px;font-weight:400;color:#67757f;">${changes.length} 处变化</span></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table></td></tr>`;
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>:root{color-scheme:light dark;supported-color-schemes:light dark}${EMAIL_DARK_CSS}@media only screen and (max-width:640px){.email{width:100%!important}.pad{padding-left:20px!important;padding-right:20px!important}.date-col{display:block!important;width:100%!important;padding:0 0 10px!important}.detail-col{display:block!important;width:100%!important}.button{display:block!important;text-align:center!important}}</style></head><body class="email-body" bgcolor="#f3f5f6" style="margin:0;padding:0;background:#f3f5f6;color:#1d252c;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-synthesis:none;font-variant-numeric:tabular-nums;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div><table class="email-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f3f5f6" style="width:100%;background:#f3f5f6;"><tr><td class="email-page" align="center" bgcolor="#f3f5f6" style="padding:24px 12px 32px;background:#f3f5f6;"><!--[if mso]><table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]--><table class="email email-card" role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:620px;max-width:620px;background:#ffffff;border-top:5px solid #174f78;box-shadow:0 0 0 1px rgba(20,40,55,.07);"><tr><td class="pad email-surface email-header" bgcolor="#ffffff" style="padding:18px 32px 16px;background:#ffffff;border-bottom:1px solid #e5e9ec;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="email-brand" style="font-family:${EMAIL_FONT};font-size:16px;line-height:23px;font-weight:700;color:#174f78;">CQU.MOE</td><td class="email-muted" align="right" style="font-family:${EMAIL_FONT};font-size:13px;line-height:19px;color:#64727c;">重庆大学课表</td></tr></table></td></tr><tr><td class="pad email-surface" bgcolor="#ffffff" style="padding:22px 32px 18px;background:#ffffff;"><h1 class="email-primary" style="margin:0;font-family:${EMAIL_FONT};font-size:24px;line-height:33px;font-weight:700;letter-spacing:-.01em;color:#1d252c;">课表与考试安排有更新</h1><p class="email-secondary" style="margin:7px 0 0;font-family:${EMAIL_FONT};font-size:15px;line-height:23px;color:#4f5e68;">本次同步发现 ${diff.total} 处未来安排发生变化，具体如下。</p></td></tr>${renderHtmlSection("课程表", "course", diff.courses, 0)}${renderHtmlSection("考试安排", "exam", diff.exams, diff.courses.length > 0 ? 18 : 0)}<tr><td class="pad email-surface" bgcolor="#ffffff" style="padding:22px 32px 24px;background:#ffffff;"><a class="button email-button" href="https://schedule.cqu.moe" style="display:inline-block;padding:11px 18px;background:#174f78;border-radius:5px;font-family:${EMAIL_FONT};font-size:15px;line-height:21px;font-weight:700;color:#ffffff;text-decoration:none;">查看最新课表</a></td></tr><tr><td class="pad email-footer" bgcolor="#f8f9fa" style="padding:15px 32px 18px;background:#f8f9fa;border-top:1px solid #e5e9ec;"><p class="email-muted" style="margin:0;font-family:${EMAIL_FONT};font-size:13px;line-height:20px;color:#64727c;">同步时间：${formatSyncTime(syncedAt)}</p><p class="email-muted" style="margin:4px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:20px;color:#64727c;">你已开启课表变更通知。<a class="email-accent" href="https://schedule.cqu.moe/#notification-settings" style="color:#174f78;text-decoration-thickness:from-font;text-underline-position:from-font;">管理通知设置</a></p><p class="email-muted" style="margin:10px 0 0;font-family:${EMAIL_FONT};font-size:12px;line-height:18px;color:#7f8b93;">CQU.MOE 是学生维护的非官方服务，请以学校系统中的最新信息为准。</p></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
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
