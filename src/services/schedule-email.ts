import type { RenderedScheduleEmail, ScheduleChange, ScheduleDatePair, ScheduleDetails, ScheduleDiff } from "./schedule-notifications";

// Hex equivalents of frontend/src/assets/styles/globals.css, for email clients without CSS variables/OKLCH.
const FONT = "system-ui,-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif";
const INK = "#0c0a09";
const MUTED = "#78716c";
const BORDER = "#e7e5e4";
const TABLE = "border-collapse:collapse;table-layout:fixed;width:100%;";
const ZONE = "Asia/Shanghai";
const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", { timeZone: ZONE, year: "numeric", month: "numeric", day: "numeric", weekday: "long" });
const WEEK = 7 * 24 * 60 * 60 * 1000;
const FIELD_LABELS: [keyof ScheduleDetails, string][] = [
  ["weekday", "星期"], ["time", "时间"], ["position", "地点"], ["room", "教室"],
  ["lecturer", "老师"], ["experiment", "实验"], ["seat", "座位"],
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function dateParts(value: string) {
  const parts = DATE_FORMATTER.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return { year, key: `${year}-${month}-${day}`, date: `${month}月${day}日`, weekday: part("weekday").replace("星期", "周") };
}

function formatDate(value: string, year: boolean, weekday = true): string {
  const date = dateParts(value);
  return `${year ? date.year + "年" : ""}${date.date}${weekday ? `（${date.weekday}）` : ""}`;
}

function daysChanged(pair: ScheduleDatePair): boolean {
  return !!pair.before && !!pair.after && dateParts(pair.before).key !== dateParts(pair.after).key;
}

function weekly(pairs: ScheduleDatePair[]): boolean {
  if (pairs.length < 2) return false;
  return (["before", "after"] as const).every((side) => pairs.every((pair, index) => {
    if (!pair[side]) return false;
    return index === 0 || Date.parse(pair[side]!) - Date.parse(pairs[index - 1][side]!) === WEEK;
  }));
}

interface FieldChange { key: string; label: string; before: string; after: string }

function describe(change: ScheduleChange, exam: boolean) {
  const pairs = [...change.datePairs].sort((a, b) => (a.before ?? a.after!).localeCompare(b.before ?? b.after!));
  const before = change.beforeDetails;
  const after = change.afterDetails;
  const count = pairs.length;
  const years = [...new Set(pairs.flatMap((pair) => [pair.before, pair.after].filter((value): value is string => !!value).map((value) => dateParts(value).year)))];
  const includeYear = years.length > 1;
  const moved = pairs.some(daysChanged);
  const fields: FieldChange[] = [];
  if (before && after) {
    if (count === 1 && moved) fields.push({ key: "date", label: "日期", before: formatDate(pairs[0].before!, includeYear), after: formatDate(pairs[0].after!, includeYear) });
    for (const [key, label] of FIELD_LABELS) {
      if (before[key] === after[key] || (key === "weekday" && count === 1)) continue;
      if (key === "room" && before.room && after.room && before.position !== after.position && before.position.includes(before.room) && after.position.includes(after.room)) continue;
      fields.push({ key, label: key === "room" && exam ? "考场" : label, before: before[key] || "未提供", after: after[key] || "未提供" });
    }
  }
  const details = after ?? before!;
  const context = FIELD_LABELS.filter(([key]) => key !== "weekday" && (!before || !after || before[key] === after[key]))
    .filter(([key]) => key !== "room" || !details.room || !details.position.includes(details.room))
    .map(([key]) => details[key]).filter(Boolean);
  if (!details.position && !details.room) context.push("地点待定");
  let label: string;
  if (change.kind !== "changed") label = `${change.kind === "added" ? "新增" : "取消"}${count}${exam ? "场考试" : "次课"}`;
  else if (count > 1 && moved) label = weekly(pairs) && !exam ? `连续${count}周调课` : `共${count}次${exam ? "考试调整" : "调课"}`;
  else {
    const labels = fields.map((field) => ({ date: "改时间", weekday: "改时间", time: "改时间", position: "换地点", room: exam ? "换考场" : "换教室", lecturer: "换老师", experiment: "实验调整", seat: "改座位" })[field.key]);
    const distinct = [...new Set(labels.filter(Boolean))];
    label = distinct.length > 2 ? "多项调整" : distinct.join("、") || "安排调整";
  }
  const dateLines = pairs.map((pair) => pair.before && pair.after && daysChanged(pair)
    ? `${formatDate(pair.before, includeYear)} → ${formatDate(pair.after, includeYear)}`
    : formatDate(pair.after ?? pair.before!, includeYear));
  const scope = count === 1 ? "仅这一次" : `共${count}次`;
  const meta = moved && count === 1 ? `${years.join(" / ")}年 · ${scope}`
    : `${formatDate(pairs[0].after ?? pairs[0].before!, true)}${count > 1 ? "起" : ""} · ${scope}`;
  return { change, exam, pairs, before, after, details, fields, context, count, years, includeYear, moved, label, meta, dateLines };
}

type ChangeView = ReturnType<typeof describe>;

function paragraph(value: string, margin = "6px 0 0", size = 14, tone = "muted"): string {
  return `<p class="${tone}" style="margin:${margin};font-size:${size}px;line-height:1.65;color:${tone === "ink" ? INK : MUTED};">${escapeHtml(value)}</p>`;
}

function comparison(view: ChangeView): string {
  const rows = view.fields.map((field) => `<tr><th scope="row" class="muted" style="padding:8px 8px 8px 0;text-align:left;font-weight:400;font-size:13px;color:${MUTED};">${escapeHtml(field.label)}</th><td class="muted value" style="padding:8px 0;font-size:16px;line-height:1.5;color:${MUTED};">${escapeHtml(field.before).replace(/（/g, "<wbr>（")}</td><td class="muted" style="text-align:center;color:${MUTED};">→</td><td class="ink value" style="padding:8px 0;font-size:16px;line-height:1.5;font-weight:500;color:${INK};">${escapeHtml(field.after).replace(/（/g, "<wbr>（")}</td></tr>`).join("");
  if (!rows) return "";
  return `<table aria-label="${escapeHtml(view.change.name)}变化对照" width="100%" cellpadding="0" cellspacing="0" style="${TABLE}margin-top:16px;"><colgroup><col width="36"><col><col width="28"><col></colgroup><thead><tr><th scope="col" aria-label="项目"></th>${columnHeader("原安排")}<th scope="col" aria-label="改为"></th>${columnHeader("调整后")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function columnHeader(value: string): string {
  return `<th scope="col" class="muted" style="padding:0 0 8px;font-size:13px;line-height:1.5;font-weight:400;text-align:left;color:${MUTED};">${escapeHtml(value)}</th>`;
}

const PAIRED_COLUMNS = '<colgroup><col width="44%"><col width="12%"><col width="44%"></colgroup>';

function recurringSummary(view: ChangeView): string {
  const first = view.pairs[0], last = view.pairs[view.count - 1];
  const range = (side: "before" | "after") => `${formatDate(first[side]!, view.includeYear, false)}–${formatDate(last[side]!, view.includeYear, false)}`;
  const every = weekly(view.pairs) ? "每" : "";
  return `<table aria-label="上课日调整" width="100%" cellpadding="0" cellspacing="0" style="${TABLE}">${PAIRED_COLUMNS}<thead><tr>${columnHeader("原安排")}<th scope="col" aria-label="改为"></th>${columnHeader("调整后")}</tr></thead><tbody><tr><td class="muted" style="font-size:20px;line-height:1.4;font-weight:500;color:${MUTED};">${escapeHtml(every + view.before!.weekday)}</td><td class="muted" style="text-align:center;color:${MUTED};">→</td><td class="ink" style="font-size:20px;line-height:1.4;font-weight:600;color:${INK};">${escapeHtml(every + view.after!.weekday)}</td></tr><tr><td class="muted" style="padding-top:8px;font-size:12px;color:${MUTED};">${escapeHtml(range("before"))}</td><td></td><td class="muted" style="padding-top:8px;font-size:12px;color:${MUTED};">${escapeHtml(range("after"))}</td></tr></tbody></table>`;
}

function datesTable(view: ChangeView): string {
  if (view.count < 2) return "";
  const caption = `${view.count}次日期${view.moved ? "对照" : "明细"} · ${view.years.join(" / ")}年`;
  const rows = view.pairs.map((pair) => {
    const oldDate = pair.before ? formatDate(pair.before, view.includeYear, false) : "";
    const newDate = pair.after ? formatDate(pair.after, view.includeYear, false) : "";
    const cell = (value: string) => `<td>${escapeHtml(value)}</td>`;
    return `<tr data-date-pair height="36">${view.moved ? `${cell(oldDate)}<td align="center">→</td>${cell(newDate)}` : cell(newDate || oldDate)}</tr>`;
  }).join("");
  return `<table class="ink dates" width="100%" cellpadding="0" cellspacing="0" style="${TABLE}margin-top:28px;font-size:15px;line-height:1.6;color:${INK};"><caption class="ink" style="text-align:left;padding:0 0 14px;font-size:14px;font-weight:500;color:${INK};">${escapeHtml(caption)}</caption>${view.moved ? `${PAIRED_COLUMNS}<thead><tr>${columnHeader(`原日期（${view.before!.weekday}）`)}<th scope="col" aria-label="改为"></th>${columnHeader(`新日期（${view.after!.weekday}）`)}</tr></thead>` : ""}<tbody>${rows}</tbody></table>`;
}

function renderCard(view: ChangeView, single: boolean): string {
  const kind = view.change.kind;
  const tone = kind === "added" ? "positive" : kind === "cancelled" ? "negative" : "ink";
  const toneColor = kind === "added" ? "#047857" : kind === "cancelled" ? "#b91c1c" : INK;
  const badge = `<span class="line ${tone}" style="display:inline-block;padding:2px 8px;border:1px solid ${BORDER};border-radius:999px;color:${toneColor};font-size:12px;line-height:1.4;font-weight:500;">${escapeHtml(view.label)}</span>`;
  const heading = single ? "" : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${TABLE}"><tr><td style="padding-right:8px;"><h3 class="ink" style="margin:0;font-size:16px;line-height:1.5;font-weight:600;color:${INK};">${escapeHtml(view.change.name)}</h3></td><td width="132" align="right" valign="top">${badge}</td></tr></table>${paragraph(view.meta)}`;
  let body: string;
  if (kind === "changed") {
    const recurring = view.count > 1 && view.moved;
    const fieldView = recurring ? { ...view, fields: view.fields.filter((field) => field.key !== "weekday") } : view;
    body = `${recurring ? `${single ? "" : '<div style="height:16px;line-height:16px;">&nbsp;</div>'}${recurringSummary(view)}` : ""}${comparison(fieldView)}${view.context.length ? paragraph(`${recurring ? "不变：" : ""}${view.context.join(" · ")}`, "20px 0 0") : ""}`;
  } else {
    body = `${single ? "" : `<p class="${tone}" style="margin:14px 0 8px;font-size:16px;line-height:1.5;font-weight:500;color:${toneColor};">${escapeHtml(view.count === 1 ? `${view.details.weekday}${kind === "cancelled" ? `这次${view.exam ? "考试" : "课"}取消` : view.exam ? "新增一场考试" : "新增一次课"}` : view.label)}</p>`}${paragraph(`${view.details.weekday} ${view.details.time}`, "8px 0 0", 16, "ink")}${paragraph([view.details.position, view.details.room, view.details.lecturer, view.details.experiment, view.details.seat].filter(Boolean).join(" · ") || "地点待定")}`;
  }
  return `<tr><td style="padding-top:${single ? 20 : 12}px;"><table class="card line" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;table-layout:fixed;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;border-collapse:separate;box-shadow:0 1px 3px #0000001a,0 1px 2px -1px #0000001a;"><tr><td class="card-pad" style="padding:24px;overflow-wrap:anywhere;word-break:break-word;">${heading}${body}${datesTable(view)}</td></tr></table></td></tr>`;
}

function textSection(title: string, views: ChangeView[]): string {
  if (!views.length) return "";
  return `${title}\n${views.map((view) => [
    `${view.change.name} · ${view.label}`, `${view.years.join(" / ")}年 · ${view.count}次`,
    ...view.fields.map((field) => `${field.label}：${field.before} → ${field.after}`),
    ...view.dateLines, view.context.join(" · "),
  ].filter(Boolean).join("\n")).join("\n\n")}`;
}

const DARK_RULES = [
  [".page", "background:#0c0a09!important"], [".card", "background:#1c1917!important"],
  [".ink", "color:#fafaf9!important"], [".muted", "color:#a8a29e!important"],
  [".line", "border-color:#373431!important"], [".positive", "color:#34d399!important"],
  [".negative", "color:#fca5a5!important"], [".button", "background:#e7e5e4!important;color:#292524!important"],
];
const DARK_CSS = `@media(prefers-color-scheme:dark){${DARK_RULES.map(([selector, rule]) => `${selector}{${rule}}`).join("")}}${DARK_RULES.map(([selector, rule]) => `[data-ogsc] ${selector}{${rule}}`).join("")}`;

export function renderScheduleChangeEmail(diff: ScheduleDiff, syncedAt = new Date()): RenderedScheduleEmail {
  const courses = diff.courses.map((change) => describe(change, false));
  const exams = diff.exams.map((change) => describe(change, true));
  const all = [...courses, ...exams];
  const single = all.length === 1;
  const title = single ? all[0].change.name : all.length ? `${all.length}项安排有变化` : "没有新的安排变化";
  const subtitle = single ? `${exams.length ? "考试 · " : ""}${all[0].label}${all[0].count > 1 && all[0].moved ? "" : " · " + all[0].meta}` : `${courses.length}项课程变化，${exams.length}项考试变化。`;
  const subject = `课表与考试安排有更新（${all.length}项）`;
  const sections = [["课程", courses], ["考试", exams]] as const;
  const content = sections.map(([label, views]) => !views.length ? "" : `${single ? "" : `<tr><td><h2 class="ink" style="margin:28px 0 0;font-size:16px;line-height:1.5;font-weight:600;color:${INK};">${label}</h2></td></tr>`}${views.map((view) => renderCard(view, single)).join("")}`).join("");
  const syncDate = `${formatDate(syncedAt.toISOString(), true, false)} ${new Intl.DateTimeFormat("zh-CN", {timeZone:ZONE,hour:"2-digit",minute:"2-digit",hour12:false}).format(syncedAt)}`;
  const html = `<!doctype html><html lang="zh-CN" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(subject)}</title><style>:root{color-scheme:light dark}${DARK_CSS}@media only screen and (max-width:480px){.outer-pad{padding:24px 16px!important}.card-pad{padding:20px 16px!important}.value{font-size:15px!important}}a:focus-visible{outline:2px solid currentColor;outline-offset:3px}</style></head><body class="page" bgcolor="#ffffff" style="margin:0;padding:0;background:#ffffff;font-family:${FONT};color:${INK};-webkit-font-smoothing:antialiased;"><div lang="zh-CN" dir="ltr" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(subtitle)}</div><table lang="zh-CN" dir="ltr" class="page" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background:#ffffff;"><tr><td align="center"><!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;table-layout:fixed;font-family:${FONT};"><tr><td class="outer-pad" style="padding:32px 24px;overflow-wrap:anywhere;"><p class="ink" style="margin:0;font-size:18px;font-weight:600;line-height:1.5;color:${INK};">CQU Schedule</p><h1 class="ink" style="margin:24px 0 6px;font-size:24px;line-height:1.4;font-weight:600;color:${INK};">${escapeHtml(title)}</h1>${paragraph(subtitle, "0")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${TABLE}">${content}</table><p style="margin:24px 0 0;"><a class="button" href="https://schedule.cqu.moe/" style="display:inline-block;padding:12px 16px;background:#292524;color:#fafaf9;border-radius:8px;font-size:14px;line-height:20px;font-weight:500;text-decoration:none;">查看最新课表</a></p><table class="line" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-top:16px;border-top:1px solid ${BORDER};"><tr><td style="padding-top:18px;">${paragraph(`同步于${syncDate}（北京时间）`, "0", 12)}<p class="muted" style="margin:4px 0 0;color:${MUTED};font-size:12px;line-height:1.7;">你已开启课表变更通知 · <a class="muted" href="https://schedule.cqu.moe/#notification-settings" style="display:inline-block;padding:10px 0;color:${MUTED};text-decoration:underline;">管理通知设置</a></p>${paragraph("CQU.MOE 是学生维护的非官方服务。安排请以学校系统为准。", "4px 0 0", 12)}</td></tr></table></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  const text = ["CQU Schedule", title, subtitle, textSection("课程表", courses), textSection("考试安排", exams), `同步于${syncDate}（北京时间）`, "查看最新课表：https://schedule.cqu.moe/", "管理通知设置：https://schedule.cqu.moe/#notification-settings"].filter(Boolean).join("\n\n");
  return { subject, html, text };
}

export function createScheduleNotificationMessages(
  diff: ScheduleDiff,
  syncedAt: Date,
  userId: string,
  notificationId: string,
): import("./schedule-notifications").ScheduleNotificationMessageV1[] {
  type Entry = { section: "courses" | "exams"; change: ScheduleChange };
  const pending: Entry[] = [
    ...diff.courses.map((change) => ({ section: "courses" as const, change })),
    ...diff.exams.map((change) => ({ section: "exams" as const, change })),
  ];
  const render = (entries: Entry[]) => renderScheduleChangeEmail({
    courses: entries.filter((entry) => entry.section === "courses").map((entry) => entry.change),
    exams: entries.filter((entry) => entry.section === "exams").map((entry) => entry.change),
    total: entries.length,
  }, syncedAt);
  // Leave headroom for the v1 envelope and part labels below the Queue and Auth consumer limits.
  const fits = (mail: RenderedScheduleEmail) => mail.html.length < 90 * 1024
    && mail.text.length < 45 * 1024
    && new TextEncoder().encode(JSON.stringify(mail)).length < 110 * 1024;
  const mails: RenderedScheduleEmail[] = [];
  let current: Entry[] = [];
  while (pending.length) {
    const entry = pending.shift()!;
    if (fits(render([...current, entry]))) {
      current.push(entry);
    } else if (current.length) {
      mails.push(render(current));
      current = [];
      pending.unshift(entry);
    } else {
      const count = entry.change.datePairs.length;
      if (count < 2) throw new Error("Schedule change exceeds email delivery limits");
      const middle = Math.ceil(count / 2);
      const part = (start: number, end: number): Entry => ({
        section: entry.section,
        change: { ...entry.change, dates: entry.change.dates.slice(start, end), datePairs: entry.change.datePairs.slice(start, end) },
      });
      pending.unshift(part(0, middle), part(middle, count));
    }
  }
  if (current.length) mails.push(render(current));
  return mails.map((mail, index) => {
    const label = mails.length > 1 ? `第${index + 1}/${mails.length}封` : "";
    return {
      version: 1,
      notificationId: mails.length > 1 ? `${notificationId}-${index + 1}` : notificationId,
      userId,
      subject: label ? `${mail.subject} · ${label}` : mail.subject,
      html: label ? mail.html.replace("</h1>", `</h1>${paragraph(label, "0 0 6px", 12)}`) : mail.html,
      text: label ? `${label}\n\n${mail.text}` : mail.text,
      createdAt: syncedAt.toISOString(),
    };
  });
}
