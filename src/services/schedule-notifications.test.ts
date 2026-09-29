import { describe, expect, it } from "vitest";
import {
  diffFutureSchedule,
  normalizeSchedule,
  renderScheduleChangeEmail,
  createScheduleNotificationMessages,
} from "./schedule-notifications";
import type { PersonalScheduleData } from "./sync";

const course = (overrides: Partial<PersonalScheduleData["courses"][number]> = {}) => ({
  name: "高等数学",
  lecturer: "张老师",
  room: "A101",
  position: "虎溪校区A101",
  day_of_week: 2,
  start_session: 1,
  end_session: 2,
  weeks: [1],
  ...overrides,
});

const exam = (overrides: Partial<PersonalScheduleData["exams"][number]> = {}) => ({
  name: "大学物理",
  room: "D1137",
  seat: 18,
  start_time: "2026-09-10T01:00:00.000Z",
  end_time: "2026-09-10T03:00:00.000Z",
  ...overrides,
});

describe("schedule notification snapshots", () => {
  it("normalizes whitespace, duplicate weeks, and source ordering", async () => {
    const left = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ name: " 高等数学 ", weeks: [2, 1, 2] }), course({ name: "英语" })],
      exams: [exam({ name: " 大学物理 " })],
    });
    const right = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ name: "英语" }), course({ weeks: [1, 2] })],
      exams: [exam()],
    });

    expect(left).toEqual(right);
  });
});

describe("diffFutureSchedule", () => {
  it("reports concrete future course and exam dates in China time", () => {
    const oldSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course()],
      exams: [exam()],
    });
    const newSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ room: "A102", position: "虎溪校区A102" })],
      exams: [exam({ room: "D1237", seat: 20 })],
    });

    const diff = diffFutureSchedule(
      oldSnapshot,
      newSnapshot,
      new Date("2026-09-07T00:00:00.000Z"),
    );

    expect(diff.total).toBe(2);
    expect(diff.courses[0]).toMatchObject({
      kind: "changed",
      name: "高等数学",
      dates: ["2026年9月8日 星期二 08:30–10:10"],
    });
    expect(diff.exams[0]).toMatchObject({
      kind: "changed",
      name: "大学物理",
      dates: ["2026年9月10日 星期四 09:00–11:00"],
    });
  });

  it("detects a position-only course location change", () => {
    const oldSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course()],
      exams: [],
    });
    const newSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ position: "虎溪校区第二实验楼A101" })],
      exams: [],
    });

    const diff = diffFutureSchedule(oldSnapshot, newSnapshot, new Date("2026-09-07T00:00:00.000Z"));

    expect(diff.total).toBe(1);
    expect(diff.courses[0]).toMatchObject({ kind: "changed", name: "高等数学" });
  });

  it("groups a recurring course adjustment without dropping dates", () => {
    const oldSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ weeks: [1, 2, 3, 4, 5, 6, 7] })],
      exams: [],
    });
    const newSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ room: "A102", weeks: [1, 2, 3, 4, 5, 6, 7] })],
      exams: [],
    });

    const diff = diffFutureSchedule(oldSnapshot, newSnapshot, new Date("2026-09-07T00:00:00.000Z"));

    expect(diff.total).toBe(1);
    expect(diff.courses[0].dates).toHaveLength(7);
    expect(diff.courses[0].extraDates).toBe(0);
  });

  it("keeps exact same-name exams paired before classifying a removal", () => {
    const laterExam = exam({
      start_time: "2026-09-10T05:00:00.000Z",
      end_time: "2026-09-10T07:00:00.000Z",
      room: "D1237",
    });
    const oldSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [],
      exams: [exam(), laterExam],
    });
    const newSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [],
      exams: [laterExam],
    });

    const diff = diffFutureSchedule(oldSnapshot, newSnapshot, new Date("2026-09-07T00:00:00.000Z"));

    expect(diff.total).toBe(1);
    expect(diff.exams[0]).toMatchObject({ kind: "cancelled", name: "大学物理" });
  });

  it("ignores occurrences that ended at or before the sync time", () => {
    const oldSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course()],
      exams: [exam()],
    });
    const newSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [],
      exams: [],
    });

    expect(diffFutureSchedule(
      oldSnapshot,
      newSnapshot,
      new Date("2026-09-11T00:00:00.000Z"),
    ).total).toBe(0);
  });
});

const now = new Date("2026-09-07T00:00:00Z");
const render = (oldCourses: ReturnType<typeof course>[], newCourses: ReturnType<typeof course>[], oldExams: ReturnType<typeof exam>[] = [], newExams: ReturnType<typeof exam>[] = []) => renderScheduleChangeEmail(diffFutureSchedule(
  normalizeSchedule({ semesterStart: "2026-09-07", courses: oldCourses, exams: oldExams }),
  normalizeSchedule({ semesterStart: "2026-09-07", courses: newCourses, exams: newExams }), now,
), now);

describe("renderScheduleChangeEmail", () => {
  it("compares changed fields without repeating unchanged context or parsing teacher separators", () => {
    const original = course({ name: "数学 <实验>", position: "虎溪校区", lecturer: "张 · 老师" });
    const result = render([original], [{ ...original, room: "A102" }]);
    expect(result.text).toContain("教室：A101 → A102");
    expect(result.text).not.toContain("老师：张 · 老师 →");
    expect(result.html.split("张 · 老师")).toHaveLength(2);
    expect(result.html).toContain("数学 &lt;实验&gt;");
    expect(result.html).not.toContain("数学 <实验>");
    expect(result.html).toContain("CQU Schedule");
    expect(result.html).toContain('scope="col"');
    expect(result.html).toContain('lang="zh-CN" dir="ltr"');
    expect(result.html).not.toContain("var(--");
    expect(result.html).not.toContain("oklch(");
  });

  it("shows all eight paired dates for eight consecutive weekly moves", () => {
    const original = course({ day_of_week: 3, weeks: [1,2,3,4,5,6,7,8], position: "虎溪校区" });
    const result = render([original], [{ ...original, day_of_week: 5 }]);
    expect(result.text).toContain("连续8周调课");
    expect(result.text).toContain("星期：周三 → 周五");
    expect(result.text).toContain("10月28日（周三） → 10月30日（周五）");
    expect(result.html).toContain("10月30日");
    expect(result.text).not.toContain("另有");
    expect(result.html.match(/data-date-pair/g)).toHaveLength(8);
  });

  it("does not call sparse weeks consecutive and separates an exceptional adjustment", () => {
    const original = course({ day_of_week: 3, weeks: [1,3,5] });
    const sparse = render([original], [{ ...original, day_of_week: 5 }]);
    expect(sparse.text).not.toContain("连续3周");
    expect(sparse.text).toContain("共3次调课");
    const result = render([course({ day_of_week: 3, weeks: [1,2,3] })], [course({ day_of_week: 5, weeks: [1,3] }), course({ day_of_week: 4, weeks: [2] })]);
    expect(result.text).toContain("周三 → 周五");
    expect(result.text).toContain("9月17日（周四）");
  });

  it("reports time and location changes together and keeps both dates", () => {
    const original = course({ day_of_week: 3, position: "虎溪校区" });
    const result = render([original], [{ ...original, day_of_week: 5, start_session: 3, end_session: 4, room: "A102" }]);
    expect(result.text).toContain("日期：9月9日（周三） → 9月11日（周五）");
    expect(result.text).toContain("时间：08:30–10:10 → 10:30–12:10");
    expect(result.text).toContain("教室：A101 → A102");
  });

  it("distinguishes cancellation and addition of individual occurrences", () => {
    const result = render([course({ name: "英语", weeks: [1,2] })], [course({ name: "英语", weeks: [2] }), course({ name: "程序设计", day_of_week: 6 })]);
    expect(result.text).toContain("取消1次课");
    expect(result.text).toContain("新增1次课");
    expect(result.text).toContain("9月8日（周二）");
    expect(result.text).toContain("9月12日（周六）");
    expect(result.text).not.toContain("整门");
  });

  it("shows exam room and seat changes while preserving teacher-only course changes", () => {
    const result = render([course()], [course({ lecturer: "李老师" })], [exam()], [exam({ room: "D1237", seat: 20 })]);
    expect(result.text).toContain("老师：张老师 → 李老师");
    expect(result.text).toContain("考场：D1137 → D1237");
    expect(result.text).toContain("座位：18号 → 20号");
    expect(result.html).toContain("考试");
  });

  it("retains the years on cross-year exam moves and handles empty diffs", () => {
    const result = render([], [], [exam({start_time:"2026-12-31T01:00:00Z",end_time:"2026-12-31T03:00:00Z"})], [exam({start_time:"2027-01-01T01:00:00Z",end_time:"2027-01-01T03:00:00Z"})]);
    expect(result.text).toContain("2026年12月31日");
    expect(result.text).toContain("2027年1月1日");
    expect(render([], []).html).toContain("没有新的安排变化");
  });
});

describe("notification message sizing", () => {
  it("preserves a full semester across bounded emails without reusing delivery IDs", () => {
    const originals = Array.from({ length: 40 }, (_, index) => course({ name: `课程${index}`, day_of_week: 3, weeks: Array.from({ length: 18 }, (_, week) => week + 1) }));
    const diff = diffFutureSchedule(normalizeSchedule({ semesterStart:"2026-09-07", courses:originals, exams:[] }), normalizeSchedule({ semesterStart:"2026-09-07", courses:originals.map(item=>({...item,day_of_week:5})), exams:[] }), now);
    const messages = createScheduleNotificationMessages(diff, now, "user-1", "schedule-v1-batch");
    expect(messages.length).toBeGreaterThan(1);
    expect(new Set(messages.map(message=>message.notificationId)).size).toBe(messages.length);
    expect(messages.reduce((count,message)=>count+(message.html.match(/data-date-pair/g)?.length ?? 0),0)).toBe(720);
    for (const message of messages) {
      expect(message.html.length).toBeLessThan(100*1024);
      expect(message.text.length).toBeLessThan(50*1024);
      expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThan(128*1024);
    }
  });

  it("labels a single exam time change as an exam", () => {
    const result=render([],[],[exam({seat:0})],[exam({seat:0,start_time:"2026-09-10T02:00:00Z",end_time:"2026-09-10T04:00:00Z"})]);
    expect(result.html).toContain("考试 · 改时间");
  });
});
