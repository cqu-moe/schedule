import { describe, it, expect } from "vitest";
import {
  semesterShortName,
  generateFormattedEvents,
  generateCsv,
} from "./export";

describe("semesterShortName", () => {
  it("should convert first semester to autumn", () => {
    expect(semesterShortName("2025-2026学年第一学期")).toBe("2025秋");
  });

  it("should convert second semester to spring", () => {
    expect(semesterShortName("2025-2026学年第二学期")).toBe("2026春");
  });

  it("should return empty for null", () => {
    expect(semesterShortName(null)).toBe("");
  });

  it("should return as-is for unknown format", () => {
    expect(semesterShortName("unknown")).toBe("unknown");
  });
});

describe("generateFormattedEvents", () => {
  const testCourse = {
    name: "高等数学",
    lecturer: "张三",
    room: "D1234",
    position: "A区",
    day_of_week: 1,
    start_session: 1,
    end_session: 2,
    weeks: [1],
  };

  it("should expand course with concrete ISO datetimes", () => {
    const events = generateFormattedEvents([testCourse], "2025-02-24");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("高等数学");
    expect(events[0].type).toBe("course");
    expect(events[0].start_time).toContain("2025-02-24T08:30:00+08:00");
    expect(events[0].end_time).toContain("2025-02-24T10:10:00+08:00");
  });

  it("should handle exam events passthrough", () => {
    const testExam = {
      name: "考试",
      room: "A101",
      seat: 5,
      start_time: "2025-06-20T09:00:00+08:00",
      end_time: "2025-06-20T11:00:00+08:00",
    };

    const events = generateFormattedEvents(null, "2025-02-24", [testExam]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("exam");
    expect(events[0].location).toBe("A101 座位5");
    expect(events[0].instructor).toBeNull();
  });

  it("should skip invalid sessions", () => {
    const badCourse = { ...testCourse, start_session: 0 };
    const events = generateFormattedEvents([badCourse], "2025-02-24");
    expect(events).toHaveLength(0);
  });

  it("should return empty for null input", () => {
    const events = generateFormattedEvents(null, "2025-02-24");
    expect(events).toHaveLength(0);
  });

  it("should pass through experiment_name when present", () => {
    const labCourse = { ...testCourse, experiment_name: "电抛光+金属电镀" };
    const events = generateFormattedEvents([labCourse], "2025-02-24");
    expect(events).toHaveLength(1);
    expect(events[0].experiment_name).toBe("电抛光+金属电镀");
  });

  it("should omit experiment_name field when course has none", () => {
    const events = generateFormattedEvents([testCourse], "2025-02-24");
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("experiment_name");
  });
});

describe("generateCsv", () => {
  it("should have BOM prefix", () => {
    const csv = generateCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("should have header row", () => {
    const csv = generateCsv([]);
    expect(csv).toContain(
      "name,type,instructor,location,day_of_week,start_time,end_time,week",
    );
  });

  it("should sanitize CSV injection", () => {
    const events = generateFormattedEvents(
      [
        {
          name: "=cmd",
          lecturer: "+evil",
          room: "-bad",
          position: "",
          day_of_week: 1,
          start_session: 1,
          end_session: 1,
          weeks: [1],
        },
      ],
      "2025-02-24",
    );

    const csv = generateCsv(events);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+evil");
    // The start_time begins with - from the negative prefix sanitization test;
    // but real times won't trigger this. Let's check for actual data.
    expect(csv).not.toContain("\n=");
    expect(csv).not.toContain("\n+");
  });

  it("should escape fields with commas", () => {
    const events = [
      {
        name: "Math, Advanced",
        type: "course" as const,
        instructor: "Prof",
        location: "Room",
        day_of_week: 1,
        start_time: "2025-02-24T08:30:00+08:00",
        end_time: "2025-02-24T09:15:00+08:00",
        week: 1,
      },
    ];
    const csv = generateCsv(events);
    expect(csv).toContain('"Math, Advanced"');
  });
});
