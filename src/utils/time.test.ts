import { describe, it, expect } from "vitest";
import { calculateCourseEventTime } from "./time";

describe("calculateCourseEventTime", () => {
  // 2025-02-24 is a Monday (week 1, day 1)
  const termStart = new Date("2025-02-24T00:00:00Z");

  it("returns correct UTC time for week 1, Monday, 08:30:00", () => {
    const result = calculateCourseEventTime(termStart, 1, 1, "08:30:00");
    // China 08:30 = UTC 00:30
    expect(result.toISOString()).toBe("2025-02-24T00:30:00.000Z");
  });

  it("returns correct UTC time for week 2, Wednesday, 14:00:00", () => {
    const result = calculateCourseEventTime(termStart, 2, 3, "14:00:00");
    // 2025-03-05 China 14:00 = UTC 06:00
    expect(result.toISOString()).toBe("2025-03-05T06:00:00.000Z");
  });

  it("returns correct UTC time for week 1, Friday, 22:00:00", () => {
    const result = calculateCourseEventTime(termStart, 1, 5, "22:00:00");
    // Feb 28, China 22:00 = UTC 14:00
    expect(result.toISOString()).toBe("2025-02-28T14:00:00.000Z");
  });
});
