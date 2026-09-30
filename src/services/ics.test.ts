import { describe, it, expect } from "vitest";
import { generateCoursesIcs, generateExamsIcs, mergeIcs } from "./ics";
import type { CourseEntry, ExamEntry } from "./cqu-api";

const testCourse: CourseEntry = {
  name: "高等数学",
  lecturer: "张三",
  room: "D1234",
  position: "A区",
  day_of_week: 1, // Monday
  start_session: 1,
  end_session: 2,
  weeks: [1, 2],
};

const testExam: ExamEntry = {
  name: "高等数学考试",
  room: "A101",
  seat: 15,
  start_time: "2025-06-20T09:00:00+08:00",
  end_time: "2025-06-20T11:00:00+08:00",
};

describe("generateCoursesIcs", () => {
  it("should generate valid VCALENDAR structure", async () => {
    const ics = await generateCoursesIcs(
      [testCourse],
      "2025-02-24",
      "student1",
    );

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//CQU Schedule//CN");
  });

  it("should generate correct number of VEVENTs (one per week)", async () => {
    const ics = await generateCoursesIcs(
      [testCourse],
      "2025-02-24",
      "student1",
    );

    const eventCount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(eventCount).toBe(2); // 2 weeks
  });

  it("should include DTSTART/DTEND in UTC format", async () => {
    const ics = await generateCoursesIcs(
      [testCourse],
      "2025-02-24",
      "student1",
    );

    // Week 1, Monday: 2025-02-24, session 1 starts 08:30 CST = 00:30 UTC
    expect(ics).toContain("DTSTART:20250224T003000Z");
    // Session 2 ends 10:10 CST = 02:10 UTC
    expect(ics).toContain("DTEND:20250224T021000Z");
  });

  it("should include VALARM with -PT15M trigger", async () => {
    const ics = await generateCoursesIcs(
      [testCourse],
      "2025-02-24",
      "student1",
    );

    expect(ics).toContain("TRIGGER:-PT15M");
    expect(ics).toContain("ACTION:DISPLAY");
  });

  it("should include course info", async () => {
    const ics = await generateCoursesIcs(
      [testCourse],
      "2025-02-24",
      "student1",
    );

    expect(ics).toContain("SUMMARY:高等数学");
    expect(ics).toContain("LOCATION:D1234");
    expect(ics).toContain("DESCRIPTION:教师：张三");
  });

  it("should use position when room is empty", async () => {
    const courseNoRoom: CourseEntry = { ...testCourse, room: "" };
    const ics = await generateCoursesIcs(
      [courseNoRoom],
      "2025-02-24",
      "student1",
    );

    expect(ics).toContain("LOCATION:A区");
  });

  it("should append experiment_name to DESCRIPTION for lab courses", async () => {
    const labCourse: CourseEntry = {
      ...testCourse,
      name: "大学化学实验Ⅰ",
      lecturer: "陈刚",
      experiment_name: "氧化还原与电化学,五水硫酸铜晶体的制备及表征",
    };
    const ics = await generateCoursesIcs(
      [labCourse],
      "2025-02-24",
      "student1",
    );

    // SUMMARY must stay equal to course.name to preserve UID stability
    expect(ics).toContain("SUMMARY:大学化学实验Ⅰ");
    // ICS escapes \n as literal "\\n" and "," as "\\,"
    expect(ics).toContain(
      "DESCRIPTION:教师：陈刚\\n实验内容：氧化还原与电化学\\,五水硫酸铜晶体的制备及表征",
    );
  });

  it("should keep DESCRIPTION minimal when experiment_name is missing", async () => {
    const ics = await generateCoursesIcs([testCourse], "2025-02-24", "student1");
    expect(ics).toContain("DESCRIPTION:教师：张三");
    expect(ics).not.toContain("实验内容");
  });

  it("should strip bare CR from course fields (#94)", async () => {
    const crCourse: CourseEntry = {
      ...testCourse,
      name: "高等\r数学",
      lecturer: "张三\r\n李四",
    };
    const ics = await generateCoursesIcs([crCourse], "2025-02-24", "student1");

    // Isolated CR removed; CRLF collapses to the same escaped \n as LF
    expect(ics).toContain("SUMMARY:高等数学");
    expect(ics).toContain("张三\\n李四");
    // Every remaining CR must be a CRLF line separator, never a bare CR
    expect(ics).not.toMatch(/\r(?!\n)/);
  });
});

describe("generateExamsIcs", () => {
  it("should generate exam events with -PT1H alarm", async () => {
    const ics = await generateExamsIcs([testExam], "student1");

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:高等数学考试");
    expect(ics).toContain("LOCATION:A101");
    expect(ics).toContain("DESCRIPTION:座位: 15");
    expect(ics).toContain("TRIGGER:-PT1H");
  });

  it("should have correct DTSTART/DTEND in UTC", async () => {
    const ics = await generateExamsIcs([testExam], "student1");

    // 09:00 CST = 01:00 UTC
    expect(ics).toContain("DTSTART:20250620T010000Z");
    // 11:00 CST = 03:00 UTC
    expect(ics).toContain("DTEND:20250620T030000Z");
  });

  it("should have empty description when seat is 0", async () => {
    const examNoSeat: ExamEntry = { ...testExam, seat: 0 };
    const ics = await generateExamsIcs([examNoSeat], "student1");

    expect(ics).toContain("DESCRIPTION:");
    expect(ics).not.toContain("座位:");
  });
});

describe("mergeIcs", () => {
  it("should merge events from both ICS sources", async () => {
    const coursesIcs = await generateCoursesIcs(
      [testCourse],
      "2025-02-24",
      "student1",
    );
    const examsIcs = await generateExamsIcs([testExam], "student1");
    const merged = mergeIcs(coursesIcs, examsIcs);

    // 2 course events + 1 exam event
    const eventCount = (merged.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(eventCount).toBe(3);

    expect(merged).toContain("SUMMARY:高等数学");
    expect(merged).toContain("SUMMARY:高等数学考试");
    expect(merged).toContain("BEGIN:VCALENDAR");
    expect(merged).toContain("END:VCALENDAR");
  });
});
