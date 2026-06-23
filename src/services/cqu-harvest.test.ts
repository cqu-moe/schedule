import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildPersonalHarvestArgs,
  mapHarvestToSessionContext,
  mapHarvestToPersonalData,
  HarvestError,
} from "./cqu-harvest";
import type { CquHarvestResult, HarvestEntry } from "./auth-rpc";

const CLIENT = { CALENDAR_CLIENT_ID: "cid", CALENDAR_CLIENT_SECRET: "csec" };

/** Minimal env stub carrying the credentials + a mock AUTH binding. */
function envWith(harvest: (args: unknown) => Promise<CquHarvestResult>) {
  return { ...CLIENT, AUTH: { cquHarvest: vi.fn(harvest) } } as never;
}

function entry(url: string, body: unknown): HarvestEntry {
  return { url, status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

afterEach(() => vi.restoreAllMocks());

describe("buildPersonalHarvestArgs", () => {
  it("builds the personal-curriculum recipe: navUrl + capture + fetch + creds", () => {
    const args = buildPersonalHarvestArgs(envWith(async () => ({ captures: [], fetches: [] })) as never, "user-1");

    expect(args.clientId).toBe("cid");
    expect(args.clientSecret).toBe("csec");
    expect(args.userId).toBe("user-1");
    // Navigating /workspace/curriculum is what organically fires the 课表 POST.
    expect(args.navUrl).toBe("https://my.cqu.edu.cn/workspace/curriculum");
    // Capture the auto-fired 课表 + session-list responses by URL substring.
    expect(args.capture).toContain("my-table-detail");
    expect(args.capture).toContain("session/info-detail");
    // In-page GETs (读豁免): exam list (always) — semester dates are added per-call
    // in fetchPersonalHarvest once curSessionId is known.
    expect(args.fetch.some((f) => f.url.includes("get-student-exam-list"))).toBe(true);
    expect(args.fetch.every((f) => f.method === "GET")).toBe(true);
  });

  it("only targets my.cqu.edu.cn hosts (auth host-whitelists; keep recipe in-bound)", () => {
    const args = buildPersonalHarvestArgs(envWith(async () => ({ captures: [], fetches: [] })) as never, "user-1");
    const hosts = [args.navUrl, ...args.fetch.map((f) => f.url)].map((u) => new URL(u).host);
    expect(hosts.every((h) => h === "my.cqu.edu.cn")).toBe(true);
  });
});

describe("mapHarvestToSessionContext", () => {
  it("derives sessionId from the captured session/info-detail body", () => {
    const captures = [
      entry("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", {
        curSessionId: "sess-9",
        sessionFinder: [{ id: "sess-9", name: "2025秋" }],
      }),
    ];
    // semester dates come from a session/info/{id} in-page fetch (read豁免).
    const fetches = [
      entry("https://my.cqu.edu.cn/api/resourceapi/session/info/sess-9", {
        data: { id: "sess-9", year: "2025", term: "秋", beginDate: "2025-09-01 00:00:00", endDate: "2026-01-15 00:00:00" },
      }),
    ];
    const ctx = mapHarvestToSessionContext(captures, fetches);
    expect(ctx.sessionId).toBe("sess-9");
    expect(ctx.semesterInfo.id).toBe("sess-9");
    expect(ctx.semesterInfo.name).toBe("2025秋");
    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01"); // split on space
    expect(ctx.semesterInfo.end_date).toBe("2026-01-15");
  });

  it("throws HarvestError when no session/info-detail capture is present", () => {
    expect(() => mapHarvestToSessionContext([], [])).toThrow(HarvestError);
  });
});

describe("mapHarvestToPersonalData", () => {
  it("parses captured 课表 + fetched exam list via the shared pure parsers", () => {
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail?CAqWHAeT=x", {
        classTimetableVOList: [
          {
            courseName: "高等数学",
            instructorName: "张三-1",
            roomName: "D1144",
            position: "A区",
            weekDay: 1,
            teachingWeek: "11111",
            period: "11000000000000",
          },
        ],
      }),
    ];
    const fetches = [
      entry("https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list", {
        status: "success",
        data: { content: [{ courseName: "高等数学", examDate: "2026-01-10", startTime: "09:00", endTime: "11:00", roomName: "D1101", seatNum: "12" }] },
      }),
    ];

    const data = mapHarvestToPersonalData(captures, fetches, "2025-09-01");
    expect(data.courses).toHaveLength(1);
    expect(data.courses[0].name).toBe("高等数学");
    expect(data.courses[0].room).toBe("D1144");
    expect(data.courses[0].weeks).toEqual([1, 2, 3, 4, 5]);
    expect(data.exams).toHaveLength(1);
    expect(data.exams[0].name).toBe("高等数学考试");
    expect(data.semesterStart).toBe("2025-09-01");
  });

  it("returns empty courses (not throw) when the 课表 capture body is empty", () => {
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", { classTimetableVOList: [] }),
    ];
    const data = mapHarvestToPersonalData(captures, [], "2025-09-01");
    expect(data.courses).toEqual([]);
    expect(data.exams).toEqual([]);
  });

  it("throws HarvestError when the 课表 capture is missing entirely (harvest failed to fire it)", () => {
    expect(() => mapHarvestToPersonalData([], [], "2025-09-01")).toThrow(HarvestError);
  });
});
