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
const FULL_SESSION_URL = "https://my.cqu.edu.cn/api/resourceapi/session/list";
const CURRENT_SEMESTER = {
  id: "sess-9", year: "2025", term: "秋", beginDate: "2025-09-01", endDate: "2026-01-15",
};

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
    expect(args.navUrl).toBe(
      "https://my.cqu.edu.cn/workspace/curriculum",
    );
    // Capture the auto-fired 课表 + session-list responses by URL substring.
    expect(args.capture).toContain("my-table-detail");
    expect(args.capture).toContain("session/info-detail");
    expect(args.fetch.some((f) => f.url.includes("get-student-exam-list"))).toBe(true);
    expect(args.fetch).toContainEqual({ method: "GET", url: FULL_SESSION_URL });
    expect(args.fetch.every((f) => f.method === "GET")).toBe(true);
  });

  it("only targets the direct CQU host", () => {
    const args = buildPersonalHarvestArgs(envWith(async () => ({ captures: [], fetches: [] })) as never, "user-1");
    const hosts = [args.navUrl, ...args.fetch.map((f) => f.url)].map((u) => new URL(u).host);
    expect(hosts.every((h) => h === "my.cqu.edu.cn")).toBe(true);
  });
});

describe("mapHarvestToSessionContext", () => {
  const captures = [entry("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", {
    curSessionId: "sess-9", sessionFinder: [{ id: "sess-9", name: "2025秋" }],
  })];

  it("selects the exact captured current semester, not the first or active semester", () => {
    const ctx = mapHarvestToSessionContext(captures, [entry(FULL_SESSION_URL, {
      sessionVOList: [
        { ...CURRENT_SEMESTER, id: "sess-90", beginDate: "2026-03-02", endDate: "2026-09-06", active: "Y" },
        { ...CURRENT_SEMESTER, active: "N" },
      ],
    })]);
    expect(ctx).toEqual({
      sessionId: "sess-9",
      semesterInfo: { id: "sess-9", name: "2025秋", begin_date: "2025-09-01", end_date: "2026-01-15" },
    });
  });

  it("accepts a missing optional end date while preserving the required semester start", () => {
    const ctx = mapHarvestToSessionContext(captures, [entry(FULL_SESSION_URL, {
      sessionVOList: [{ ...CURRENT_SEMESTER, endDate: null }],
    })]);
    expect(ctx.semesterInfo).toMatchObject({ begin_date: "2025-09-01", end_date: null });
  });

  it.each([undefined, null, 1060, ""])("rejects an invalid captured curSessionId (%s)", (curSessionId) => {
    expect(() => mapHarvestToSessionContext([
      entry("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", { curSessionId }),
    ], [entry(FULL_SESSION_URL, { sessionVOList: [CURRENT_SEMESTER] })])).toThrow(HarvestError);
  });

  it("throws HarvestError when no session/info-detail capture is present", () => {
    expect(() => mapHarvestToSessionContext([], [])).toThrow(HarvestError);
  });

  it("rejects a non-2xx current-session capture", () => {
    expect(() => mapHarvestToSessionContext([
      entryWithStatus("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", 412, "<html>challenge</html>"),
    ], [])).toThrow(HarvestError);
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

  it("rejects a 200 business-error timetable body instead of treating it as empty", () => {
    const captures = [
      entry(
        "https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail",
        { status: "failed", message: "session expired" },
      ),
    ];
    const fetches = [
      entry("https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list", {
        status: "success",
        data: { content: [] },
      }),
    ];

    expect(() =>
      mapHarvestToPersonalData(captures, fetches, "2025-09-01")
    ).toThrow(HarvestError);
  });

  it("rejects 200 exam business errors or malformed success data", () => {
    const captures = [
      entry(
        "https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail",
        { classTimetableVOList: [] },
      ),
    ];
    const examUrl =
      "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list";

    for (const body of [
      { status: "failed", data: { content: [] } },
      { status: "success", data: {} },
      { status: "success", data: { content: null } },
    ]) {
      expect(() =>
        mapHarvestToPersonalData(
          captures,
          [entry(examUrl, body)],
          "2025-09-01",
        )
      ).toThrow(HarvestError);
    }
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
  function scheduleCaptures(): HarvestEntry[] {
    return [
      entry("https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail", {
        classTimetableVOList: [{
          courseName: "高等数学", instructorName: "张三-1", roomName: "D1144", position: "A区",
          weekDay: 1, teachingWeek: "11111", period: "11000000000000",
        }],
      }),
      entry("https://my.cqu.edu.cn/api/resourceapi/session/info-detail", {
        curSessionId: "sess-9", sessionFinder: [{ id: "sess-9", name: "2025秋" }],
      }),
    ];
  }

  function examFetches(): HarvestEntry[] {
    return [entry("https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list", {
      status: "success", data: { content: [] },
    })];
  }

  function fullResult() {
    return {
      captures: scheduleCaptures(),
      fetches: [...examFetches(), entry(FULL_SESSION_URL, { sessionVOList: [CURRENT_SEMESTER] })],
    };
  }

  function happyHarvestMock() {
    return vi.fn().mockResolvedValue(fullResult());
  }

  function mockCache() {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    };
  }

  it("collects courses, exams and exact semester dates in one browser invocation", async () => {
    const cquHarvest = happyHarvestMock();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: mockCache() } as never;
    const { ctx, data } = await fetchPersonalHarvest(env, "user-1");

    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01");
    expect(data.semesterStart).toBe("2025-09-01");
    expect(data.courses).toHaveLength(1);
    expect(data.courses[0].name).toBe("高等数学");
    expect(data.exams).toEqual([]);
    expect(cquHarvest).toHaveBeenCalledOnce();
    expect(cquHarvest.mock.calls[0][0].fetch).toContainEqual({ method: "GET", url: FULL_SESSION_URL });
  });

  it.each([
    ["missing full-list fetch", []],
    ["non-2xx full list", [entryWithStatus(FULL_SESSION_URL, 412, "<html>challenge</html>")]],
    ["malformed JSON", [entryWithStatus(FULL_SESSION_URL, 200, "{bad json")]],
    ["null response", [entry(FULL_SESSION_URL, null)]],
    ["missing list array", [entry(FULL_SESSION_URL, { sessionVOList: {} })]],
    ["missing current semester", [entry(FULL_SESSION_URL, { sessionVOList: [{ ...CURRENT_SEMESTER, id: "sess-other" }] })]],
    ["ambiguous current semester", [entry(FULL_SESSION_URL, { sessionVOList: [CURRENT_SEMESTER, CURRENT_SEMESTER] })]],
    ["missing begin date", [entry(FULL_SESSION_URL, { sessionVOList: [{ ...CURRENT_SEMESTER, beginDate: null }] })]],
    ["invalid begin date", [entry(FULL_SESSION_URL, { sessionVOList: [{ ...CURRENT_SEMESTER, beginDate: "not-a-date" }] })]],
    ["impossible begin date", [entry(FULL_SESSION_URL, { sessionVOList: [{ ...CURRENT_SEMESTER, beginDate: "2025-02-30" }] })]],
    ["invalid end date", [entry(FULL_SESSION_URL, { sessionVOList: [{ ...CURRENT_SEMESTER, endDate: "not-a-date" }] })]],
    ["end before begin", [entry(FULL_SESSION_URL, { sessionVOList: [{ ...CURRENT_SEMESTER, endDate: "2025-08-31" }] })]],
  ])("rejects %s without a second browser or caching partial data", async (_label, dates) => {
    const cquHarvest = vi.fn().mockResolvedValue({ captures: scheduleCaptures(), fetches: [...examFetches(), ...dates] });
    const cache = mockCache();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never;

    await expect(fetchPersonalHarvest(env, "user-1")).rejects.toBeInstanceOf(HarvestError);
    expect(cquHarvest).toHaveBeenCalledOnce();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("deduplicates successful harvests only within the same user", async () => {
    const cquHarvest = happyHarvestMock();
    const cache = mockCache();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never;
    const first = await fetchPersonalHarvest(env, "user-1");
    const second = await fetchPersonalHarvest(env, "user-1");
    expect(second).toEqual(first);
    expect(cquHarvest).toHaveBeenCalledOnce();
    await fetchPersonalHarvest(env, "user-2");
    expect(cquHarvest).toHaveBeenCalledTimes(2);
    expect(cache.get).toHaveBeenCalledWith("harvest:direct-v1:user-1");
    expect(cache.get).toHaveBeenCalledWith("harvest:direct-v1:user-2");
  });

  it("does not cache missing dates and permits the next complete harvest to succeed", async () => {
    const cquHarvest = happyHarvestMock()
      .mockResolvedValueOnce({ captures: scheduleCaptures(), fetches: examFetches() });
    const cache = mockCache();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never;
    await expect(fetchPersonalHarvest(env, "user-1")).rejects.toBeInstanceOf(HarvestError);
    expect(cache.put).not.toHaveBeenCalled();
    const { ctx } = await fetchPersonalHarvest(env, "user-1");
    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01");
    expect(cquHarvest).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("keeps a CACHE get/put failure from breaking a complete harvest", async () => {
    const cquHarvest = happyHarvestMock();
    const cache = {
      get: vi.fn(async () => { throw new Error("KV get down"); }),
      put: vi.fn(async () => { throw new Error("KV put down"); }),
    };
    const { ctx } = await fetchPersonalHarvest({ ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never, "user-1");
    expect(ctx.semesterInfo.begin_date).toBe("2025-09-01");
    expect(cquHarvest).toHaveBeenCalledOnce();
  });

  it("passes the original absolute deadline to the single browser invocation", async () => {
    const cquHarvest = happyHarvestMock();
    const deadlineAt = Date.now() + 10 * 60_000;
    await fetchPersonalHarvest({ ...CLIENT, AUTH: { cquHarvest }, CACHE: mockCache() } as never, "user-1", { deadlineAt });
    expect(cquHarvest).toHaveBeenCalledOnce();
    expect(cquHarvest.mock.calls[0][0].deadlineAt).toBe(deadlineAt);
  });

  it("keeps old callers compatible without sending an invented deadline", async () => {
    const cquHarvest = happyHarvestMock();
    await fetchPersonalHarvest({ ...CLIENT, AUTH: { cquHarvest }, CACHE: mockCache() } as never, "user-1");
    expect(cquHarvest.mock.calls[0][0]).not.toHaveProperty("deadlineAt");
  });

  it("does not start another browser for a cache hit with a new deadline", async () => {
    const cquHarvest = happyHarvestMock();
    const env = { ...CLIENT, AUTH: { cquHarvest }, CACHE: mockCache() } as never;
    await fetchPersonalHarvest(env, "user-1", { deadlineAt: Date.now() + 60_000 });
    await fetchPersonalHarvest(env, "user-1", { deadlineAt: Date.now() + 30_000 });
    expect(cquHarvest).toHaveBeenCalledOnce();
  });

  it("keeps AUTH capability and stable session errors as controlled harvest failures", async () => {
    await expect(fetchPersonalHarvest(CLIENT as never, "user-1")).rejects.toThrow("AUTH.cquHarvest unavailable");
    const cquHarvest = vi.fn().mockResolvedValue({ error: "TGT_EXPIRED" });
    const cache = mockCache();
    await expect(fetchPersonalHarvest({ ...CLIENT, AUTH: { cquHarvest }, CACHE: cache } as never, "user-1"))
      .rejects.toMatchObject({ name: "HarvestError", message: "TGT_EXPIRED" });
    expect(cquHarvest).toHaveBeenCalledOnce();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
