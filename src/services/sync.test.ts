import { describe, it, expect, vi } from "vitest";
import {
  fetchPersonalSchedule,
  fetchPersonalScheduleCached,
  type SessionContext,
} from "./sync";
import type { CQUAPIClient, CourseEntry, ExamEntry } from "./cqu-api";

const testCourse: CourseEntry = {
  name: "高等数学",
  lecturer: "张三",
  room: "D1234",
  position: "A区",
  day_of_week: 1,
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

const testCtx: SessionContext = {
  sessionId: "1001",
  semesterInfo: {
    id: "1001",
    name: "2025-2026学年第一学期",
    begin_date: "2025-02-24",
    end_date: "2025-07-01",
  },
};

function createMockApi(opts?: { delayMs?: number }) {
  const delayMs = opts?.delayMs ?? 50;
  const callLog: string[] = [];

  const api = {
    getSchedule: async (_studentId: string, _sessionId: string): Promise<CourseEntry[]> => {
      callLog.push("getSchedule:start");
      await new Promise((r) => setTimeout(r, delayMs));
      callLog.push("getSchedule:end");
      return [testCourse];
    },
    getExams: async (): Promise<ExamEntry[]> => {
      callLog.push("getExams:start");
      await new Promise((r) => setTimeout(r, delayMs));
      callLog.push("getExams:end");
      return [testExam];
    },
  } as unknown as CQUAPIClient;

  return { api, callLog };
}

describe("fetchPersonalSchedule", () => {
  it("should return courses, exams, and semesterStart", async () => {
    const { api } = createMockApi({ delayMs: 0 });
    const result = await fetchPersonalSchedule(api, "20210001", testCtx);

    expect(result.courses).toEqual([testCourse]);
    expect(result.exams).toEqual([testExam]);
    expect(result.semesterStart).toBe("2025-02-24");
  });

  it("should use empty string for semesterStart when begin_date is null", async () => {
    const { api } = createMockApi({ delayMs: 0 });
    const ctxNullDate: SessionContext = {
      ...testCtx,
      semesterInfo: { ...testCtx.semesterInfo, begin_date: null },
    };
    const result = await fetchPersonalSchedule(api, "20210001", ctxNullDate);

    expect(result.semesterStart).toBe("");
  });

  it("should call getSchedule and getExams in parallel (both start before either ends)", async () => {
    const { api, callLog } = createMockApi({ delayMs: 50 });
    await fetchPersonalSchedule(api, "20210001", testCtx);

    // In parallel execution, both :start entries appear before any :end entry.
    // In sequential execution, the order would be:
    //   getSchedule:start, getSchedule:end, getExams:start, getExams:end
    const firstEndIndex = callLog.findIndex((e) => e.endsWith(":end"));
    const startEntries = callLog.filter((e) => e.endsWith(":start"));

    // Both calls must have started before the first one ended
    expect(startEntries).toHaveLength(2);
    expect(firstEndIndex).toBeGreaterThanOrEqual(2);
  });
});

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string, _type?: string) => store[key] ? JSON.parse(store[key]) : null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value; }),
  } as unknown as KVNamespace;
}

describe("fetchPersonalScheduleCached", () => {
  it("should return cached data on cache hit without calling API", async () => {
    const cachedData = {
      courses: [testCourse],
      exams: [testExam],
      semesterStart: "2025-02-24",
    };
    const kv = mockKV({ "sync:personal:20210001": JSON.stringify(cachedData) });
    const { api } = createMockApi({ delayMs: 0 });

    const result = await fetchPersonalScheduleCached(api, "20210001", testCtx, kv);

    expect(result).toEqual(cachedData);
    expect(kv.get).toHaveBeenCalledWith("sync:personal:20210001", "json");
    // KV put should NOT have been called (cache hit = no API fetch = no write-back)
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("should fetch from API on cache miss and write to KV with TTL", async () => {
    const kv = mockKV(); // empty store = cache miss
    const { api } = createMockApi({ delayMs: 0 });

    const result = await fetchPersonalScheduleCached(api, "20210001", testCtx, kv);

    expect(result.courses).toEqual([testCourse]);
    expect(result.exams).toEqual([testExam]);
    expect(result.semesterStart).toBe("2025-02-24");

    // Should have written the result to KV
    expect(kv.put).toHaveBeenCalledWith(
      "sync:personal:20210001",
      JSON.stringify(result),
      { expirationTtl: 300 },
    );
  });
});
