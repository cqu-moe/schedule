import { describe, expect, it } from "vitest";
import {
  diffFutureSchedule,
  hashSchedule,
  normalizeSchedule,
  renderScheduleChangeEmail,
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
    expect(await hashSchedule(left)).toBe(await hashSchedule(right));
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

  it("groups a recurring course adjustment and caps its concrete dates", () => {
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
    expect(diff.courses[0].dates).toHaveLength(5);
    expect(diff.courses[0].extraDates).toBe(2);
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

describe("renderScheduleChangeEmail", () => {
  it("renders one compact HTML and text email with both sections and escaped content", () => {
    const diff = diffFutureSchedule(
      normalizeSchedule({
        semesterStart: "2026-09-07",
        courses: [course({ name: "数学 <实验>" })],
        exams: [exam()],
      }),
      normalizeSchedule({
        semesterStart: "2026-09-07",
        courses: [course({ name: "数学 <实验>", room: "A102" })],
        exams: [exam({ seat: 20 })],
      }),
      new Date("2026-09-07T00:00:00.000Z"),
    );

    const rendered = renderScheduleChangeEmail(diff, new Date("2026-09-07T13:36:00.000Z"));
    expect(rendered.subject).toBe("课表与考试安排有更新（2项）");
    expect(rendered.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(rendered.html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(rendered.html).toContain("color-scheme:light dark");
    expect(rendered.html).toContain("@media(prefers-color-scheme:dark)");
    expect(rendered.html).toContain('bgcolor="#ffffff"');
    expect(rendered.html).toContain("CQU.MOE / 重庆大学课表");
    expect(rendered.html).toContain("课表有更新");
    expect(rendered.html).toContain("有 2 项安排变更");
    expect(rendered.html).toContain("课程表 · 1 项");
    expect(rendered.html).toContain("考试安排 · 1 项");
    expect(rendered.html).toContain("9 月 8 日 · 2026 年 · 周二");
    expect(rendered.html).toContain("地点调整");
    expect(rendered.html).toContain("同步于 2026 年 9 月 7 日 21:36（北京时间）");
    expect(rendered.html).toContain("你已开启课表变更通知");
    expect(rendered.html).toContain("CQU.MOE 是学生维护的非官方服务");
    expect(rendered.html).toContain("数学 &lt;实验&gt;");
    expect(rendered.html).not.toContain("数学 <实验>");
    expect(rendered.text).toContain("课程表");
    expect(rendered.text).toContain("考试安排");
    expect(rendered.html).toContain("https://schedule.cqu.moe/");
  });

  it("shows at most five concrete dates for one course change", () => {
    const oldSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ weeks: [1, 2, 3, 4, 5, 6, 7] })],
      exams: [],
    });
    const newSnapshot = normalizeSchedule({
      semesterStart: "2026-09-07",
      courses: [course({ weeks: [] })],
      exams: [],
    });
    const rendered = renderScheduleChangeEmail(diffFutureSchedule(
      oldSnapshot,
      newSnapshot,
      new Date("2026-09-07T00:00:00.000Z"),
    ));
    expect(rendered.text).toContain("另有 2 个日期");
  });
});
