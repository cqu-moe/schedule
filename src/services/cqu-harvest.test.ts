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
    // The exam fetch is REQUIRED — supply a genuine 2xx empty exam list so this test
    // isolates the empty-课表 (courses) path, not the exam-absence path.
    const fetches = [
      entry("https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list", {
        status: "success",
        data: { content: [] },
      }),
    ];
    const data = mapHarvestToPersonalData(captures, fetches, "2025-09-01");
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

  it("throws HarvestError when the exam fetch is PRESENT-but-non-2xx (no exam-data loss)", () => {
    // Round-4 [P1 DATA LOSS]: the exam fetch is REQUIRED-when-present. A present-but
    // non-2xx exam entry (412 瑞数 challenge / 401 / 5xx) used to DEGRADE to empty
    // exams; applying that empty result as a "successful" sync overwrites a
    // previously-valid exam calendar (personal_exams / the exam slice of
    // personal_all) with nothing. Treat a present non-2xx exam capture as a harvest
    // FAILURE so the consumer acks-without-retry and leaves the cached exams intact.
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [],
      }),
    ];
    const fetches = [
      entryWithStatus(
        "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list",
        412,
        "<html>瑞数 challenge</html>",
      ),
    ];
    expect(() => mapHarvestToPersonalData(captures, fetches, "2025-09-01")).toThrow(HarvestError);
  });

  it("throws HarvestError (not SyntaxError) when the exam fetch is 2xx-but-unparseable", () => {
    // Even a 2xx exam entry can carry a truncated/HTML body (proxy hiccup). Parsing
    // it as JSON would throw a raw SyntaxError → the consumer treats it as a GENERIC
    // failure and RETRIES (amplifying load mid-WAF). The REQUIRED-when-present exam
    // parse must surface a HarvestError instead (ack-no-retry, no exam-data loss).
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
    try {
      mapHarvestToPersonalData(captures, fetches, "2025-09-01");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HarvestError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
  });

  it("a genuine 2xx exam response with an empty content list → empty exams (no throw)", () => {
    // A REAL 2xx exam body that legitimately has no exams ({data:{content:[]}}) is a
    // VALID empty-exams result, NOT a failure — only a non-2xx/parse-failure is an
    // error. The harvest must succeed with exams=[].
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [],
      }),
    ];
    const fetches = [
      entry("https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list", {
        status: "success",
        data: { content: [] },
      }),
    ];
    const data = mapHarvestToPersonalData(captures, fetches, "2025-09-01");
    expect(data.courses).toEqual([]);
    expect(data.exams).toEqual([]);
  });

  it("throws HarvestError when the exam fetch is ABSENT (dropped/failed fetch, NOT 'no exams')", () => {
    // Round-5 [P2 DATA LOSS]: buildPersonalHarvestArgs ALWAYS requests the exam URL,
    // so an ABSENT exam entry means the fetch was DROPPED/timed-out — NOT a
    // legitimately-empty exam list. Degrading absence to exams=[] and applying that
    // as a "successful" sync would ERASE a previously-valid exam calendar
    // (personal_exams / the exam slice of personal_all). The exam entry is REQUIRED:
    // absence must surface as a HarvestError (ack-no-retry, cached exams intact). A
    // genuine empty exam list arrives as a 2xx body with {data:{content:[]}} (covered
    // by the test above), NOT as an absent entry.
    const captures = [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [],
      }),
    ];
    expect(() => mapHarvestToPersonalData(captures, [], "2025-09-01")).toThrow(HarvestError);
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

  /** A `cquHarvest` mock that resolves Phase 1 then Phase 2 (with semester dates). */
  function happyHarvestMock() {
    return vi
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
  }

  /** In-memory mock of the CACHE KV binding (get/put only). */
  function mockCache() {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    };
  }

  it("returns typed ctx + data on the happy path (Phase 2 supplies semester dates)", async () => {
    const cquHarvest = happyHarvestMock();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: mockCache() } as never;

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
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: mockCache() } as never;

    await expect(fetchPersonalHarvest(env, "user-1")).rejects.toBeInstanceOf(HarvestError);
    expect(cquHarvest).toHaveBeenCalledTimes(2);
  });

  it("dedups: a second call for the SAME user reuses the cached harvest (cquHarvest fires ONCE)", async () => {
    // PERF: when a user owns multiple personal subs (personal_all + personal_courses
    // + personal_exams) processed close together, each queue message used to launch
    // its OWN expensive harvest even though the payload is IDENTICAL. The per-user
    // cache makes the second call hit env.CACHE and skip the harvest entirely.
    const cquHarvest = happyHarvestMock();
    const cache = mockCache();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never;

    const first = await fetchPersonalHarvest(env, "user-1");
    const second = await fetchPersonalHarvest(env, "user-1");

    // Phase 1 + Phase 2 = 2 cquHarvest calls for the FIRST harvest, ZERO for the second.
    expect(cquHarvest).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledWith("harvest:user-1");
    // The cached value round-trips byte-identically.
    expect(second.ctx.semesterInfo.begin_date).toBe(first.ctx.semesterInfo.begin_date);
    expect(second.data.semesterStart).toBe(first.data.semesterStart);
  });

  it("does NOT cache a failed harvest (next call re-harvests)", async () => {
    // A transient harvest failure must NOT be memoized, or a single 412/timeout would
    // poison the cache for the whole TTL. Only SUCCESSFUL harvests are cached.
    const cquHarvest = vi
      .fn()
      // First call: Phase 1 OK, Phase 2 fails → HarvestError (no dates) → not cached.
      .mockResolvedValueOnce({ captures: phase1Captures(), fetches: phase1Fetches() })
      .mockResolvedValueOnce({ error: "CQU_WAF_BLOCKED" })
      // Second call: full success.
      .mockResolvedValueOnce({ captures: phase1Captures(), fetches: phase1Fetches() })
      .mockResolvedValueOnce({
        captures: [],
        fetches: [
          entry("https://my.cqu.edu.cn/api/resourceapi/session/info/sess-9", {
            data: { id: "sess-9", year: "2025", term: "秋", beginDate: "2025-09-01 00:00:00", endDate: "2026-01-15 00:00:00" },
          }),
        ],
      });
    const cache = mockCache();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never;

    await expect(fetchPersonalHarvest(env, "user-1")).rejects.toBeInstanceOf(HarvestError);
    expect(cache.put).not.toHaveBeenCalled(); // failure not memoized

    // Second call must actually re-harvest (cache miss) and succeed.
    const { ctx } = await fetchPersonalHarvest(env, "user-1");
    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01");
    expect(cquHarvest).toHaveBeenCalledTimes(4); // 2 (failed) + 2 (success)
    expect(cache.put).toHaveBeenCalledTimes(1); // only the success is cached
  });

  it("a CACHE get/put failure does NOT break the harvest (best-effort)", async () => {
    // KV is best-effort: a get/put throwing (KV outage) must be caught so the harvest
    // still completes. The harvest proceeds and returns real data on a get failure.
    const cquHarvest = happyHarvestMock();
    const cache = {
      get: vi.fn(async () => { throw new Error("KV get down"); }),
      put: vi.fn(async () => { throw new Error("KV put down"); }),
    };
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never;

    const { ctx, data } = await fetchPersonalHarvest(env, "user-1");
    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01");
    expect(data.semesterStart).toBe("2025-09-01");
    // A get failure means a cache miss → the harvest ran.
    expect(cquHarvest).toHaveBeenCalledTimes(2);
  });
});
