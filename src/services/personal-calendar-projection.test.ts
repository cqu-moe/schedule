import { describe, expect, it } from "vitest";
import type { Subscription } from "../db/schema";
import { projectPersonalCalendar } from "./personal-calendar-projection";

const sub = {
  sourceId: "user-1",
  semesterStart: "2026-09-01",
  coursesJson: JSON.stringify([{
    name: "测试课程",
    lecturer: "教师",
    room: "A101",
    position: "",
    day_of_week: 1,
    start_session: 1,
    end_session: 2,
    weeks: [1],
  }]),
  examsJson: JSON.stringify([{
    name: "测试考试",
    room: "B201",
    seat: 1,
    start_time: "2026-12-20T01:00:00.000Z",
    end_time: "2026-12-20T03:00:00.000Z",
  }]),
} as Subscription;

describe("projectPersonalCalendar", () => {
  it("keeps courses and exams isolated by stored view type", () => {
    const courses = projectPersonalCalendar(sub, "personal_courses");
    expect(courses.icsContent).toContain("测试课程");
    expect(courses.icsContent).not.toContain("测试考试");
    expect(courses.coursesJson).toContain("测试课程");
    expect(courses.examsJson).toBeNull();

    const exams = projectPersonalCalendar(sub, "personal_exams");
    expect(exams.icsContent).toContain("测试考试");
    expect(exams.icsContent).not.toContain("测试课程");
    expect(exams.coursesJson).toBeNull();
    expect(exams.examsJson).toContain("测试考试");
  });

  it("rejects malformed or non-array stored JSON", () => {
    expect(() => projectPersonalCalendar(
      { ...sub, coursesJson: "{}" },
      "personal_all",
    )).toThrow("PERSONAL_CALENDAR_DATA_CORRUPTED");
  });
});
