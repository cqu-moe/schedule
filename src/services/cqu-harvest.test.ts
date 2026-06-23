import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildPersonalHarvestArgs,
  mapHarvestToSessionContext,
  mapHarvestToPersonalData,
  fetchPersonalHarvest,
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

/** Like `entry` but with an explicit (typically non-2xx) status code. */
function entryWithStatus(url: string, status: number, body: unknown): HarvestEntry {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return { url, status, contentType: "text/html", body: raw };
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

  it("throws HarvestError when the session/info-detail capture is non-2xx (challenge/error body)", () => {
    // A 412 瑞数 challenge (or 401/5xx) on the required session capture must NOT
    // be parsed as a successful (empty) result — that would wipe the cached
    // session/semester. Treat a non-2xx required capture as a harvest failure.
    const captures = [
      entryWithStatus(
        "https://my.cqu.edu.cn/api/resourceapi/session/info-detail",
        412,
        "<html>瑞数 challenge</html>",
      ),
    ];
    expect(() => mapHarvestToSessionContext(captures, [])).toThrow(HarvestError);
  });

  it("throws HarvestError (not SyntaxError) when the session/info/{id} semester-detail fetch is non-2xx", () => {
    // The session-list capture is fine (2xx) but the session/info/{id} semester
    // detail FETCH came back 412/401/5xx with an HTML challenge body. Running
    // JSON.parse on that HTML would throw a plain SyntaxError → the queue consumer
    // treats it as a GENERIC failure and RETRIES (amplifying load mid-WAF) instead
    // of the ack-no-retry HarvestError path. The non-2xx required detail fetch must
    // surface as a HarvestError.
    const captures = [
      entry("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", {
        curSessionId: "sess-9",
        sessionFinder: [{ id: "sess-9", name: "2025秋" }],
      }),
    ];
    const fetches = [
      entryWithStatus(
        "https://my.cqu.edu.cn/api/resourceapi/session/info/sess-9",
        412,
        "<html>瑞数 challenge</html>",
      ),
    ];
    let thrown: unknown;
    try {
      mapHarvestToSessionContext(captures, fetches);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HarvestError);
    // Guard the bug precisely: a raw SyntaxError (JSON.parse on HTML) means the
    // entry parse was NOT routed through the non-2xx guard.
    expect(thrown).not.toBeInstanceOf(SyntaxError);
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

  it("throws HarvestError when the my-table-detail capture is non-2xx (412 challenge → no empty-courses overwrite)", () => {
    // The 课表 capture came back 401/412/5xx (challenge HTML or error JSON). Feeding
    // that to parseCourses yields EMPTY courses, which — applied as a "successful"
    // sync — would WIPE the user's cached 课表. Reject the non-2xx required capture.
    const captures = [
      entryWithStatus(
        "https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail",
        412,
        "<html>瑞数 challenge</html>",
      ),
    ];
    expect(() => mapHarvestToPersonalData(captures, [], "2025-09-01")).toThrow(HarvestError);
  });

  it("degrades a non-2xx exam fetch to empty exams (optional; does NOT throw)", () => {
    // The exam fetch is OPTIONAL — a non-2xx there degrades to empty exams (matching
    // the missing-entry behavior), but must not fail the whole harvest.
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [],
      }),
    ];
    const fetches = [
      entryWithStatus(
        "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list",
        500,
        "<html>error</html>",
      ),
    ];
    const data = mapHarvestToPersonalData(captures, fetches, "2025-09-01");
    expect(data.courses).toEqual([]);
    expect(data.exams).toEqual([]);
  });

  it("degrades a 2xx-but-unparseable exam fetch to empty exams (no SyntaxError throw)", () => {
    // Even a 2xx exam entry can carry a truncated/HTML body (proxy hiccup). The
    // OPTIONAL exam parse must swallow a JSON.parse failure → empty exams, NOT
    // throw a SyntaxError that would fail (and retry) the whole personal harvest.
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [],
      }),
    ];
    const fetches: HarvestEntry[] = [
      {
        url: "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list",
        status: 200,
        contentType: "application/json",
        body: "{not valid json",
      },
    ];
    let thrown: unknown;
    let data: ReturnType<typeof mapHarvestToPersonalData> | undefined;
    try {
      data = mapHarvestToPersonalData(captures, fetches, "2025-09-01");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(data?.exams).toEqual([]);
  });
});

describe("fetchPersonalHarvest", () => {
  /** Phase-1 captures: 课表 + session/info-detail (curSessionId, no dates yet). */
  function phase1Captures(): HarvestEntry[] {
    return [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [],
      }),
      entry("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", {
        curSessionId: "sess-9",
        sessionFinder: [{ id: "sess-9", name: "2025秋" }],
      }),
    ];
  }
  /** Phase-1 in-page fetches: exam list only (no semester dates yet). */
  function phase1Fetches(): HarvestEntry[] {
    return [
      entry("https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list", {
        status: "success",
        data: { content: [] },
      }),
    ];
  }

  it("returns typed ctx + data on the happy path (Phase 2 supplies semester dates)", async () => {
    const cquHarvest = vi
      .fn()
      // Phase 1: 课表 + session-list captured, exam fetched (no dates).
      .mockResolvedValueOnce({ captures: phase1Captures(), fetches: phase1Fetches() })
      // Phase 2: session/info/{id} GET returns the semester dates.
      .mockResolvedValueOnce({
        captures: [],
        fetches: [
          entry("https://my.cqu.edu.cn/api/resourceapi/session/info/sess-9", {
            data: { id: "sess-9", year: "2025", term: "秋", beginDate: "2025-09-01 00:00:00", endDate: "2026-01-15 00:00:00" },
          }),
        ],
      });
    const env = { ...CLIENT, AUTH: { cquHarvest } } as never;

    const { ctx, data } = await fetchPersonalHarvest(env, "user-1");
    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01");
    expect(data.semesterStart).toBe("2025-09-01");
    expect(cquHarvest).toHaveBeenCalledTimes(2);
  });

  it("rejects with HarvestError when Phase 2 errors and semester dates stay missing (止血: no broken-ICS overwrite)", async () => {
    const cquHarvest = vi
      .fn()
      // Phase 1 OK but session/info-detail carries no semester dates → begin_date null.
      .mockResolvedValueOnce({ captures: phase1Captures(), fetches: phase1Fetches() })
      // Phase 2 transient failure (timeout/WAF/reauth) — dates never arrive.
      .mockResolvedValueOnce({ error: "CQU_WAF_BLOCKED" });
    const env = { ...CLIENT, AUTH: { cquHarvest } } as never;

    await expect(fetchPersonalHarvest(env, "user-1")).rejects.toBeInstanceOf(HarvestError);
    expect(cquHarvest).toHaveBeenCalledTimes(2);
  });
});
