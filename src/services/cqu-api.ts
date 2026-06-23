import type { ExternalSourceType } from "../db/schema";
import { CHINA_TZ_OFFSET_MS, formatChinaIso } from "../utils/time";

// CQU API endpoints
const SCHEDULE_URL_TEMPLATE =
  "https://my.cqu.edu.cn/api/timetable/class/timetable/student/my-table-detail?sessionId={}";
const EXAM_URL =
  "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list";
const SESSION_LIST_URL =
  "https://my.cqu.edu.cn/api/resourceapi/session/info-detail";
const SESSION_DETAIL_URL_TEMPLATE =
  "https://my.cqu.edu.cn/api/resourceapi/session/info/{}";

// Search API endpoints
const INSTRUCTOR_SEARCH_URL =
  "https://my.cqu.edu.cn/api/timetable/instructor/filter";
const ROOM_SEARCH_URL =
  "https://my.cqu.edu.cn/api/resourceapi/room/roomName-filter";
const LAB_SEARCH_URL =
  "https://my.cqu.edu.cn/api/timetable/course/LaboratoryId-filter";
const COURSE_SEARCH_URL =
  "https://my.cqu.edu.cn/api/timetable/course/info-by-name-or-code";
const COURSE_CLASS_SEARCH_URL =
  "https://my.cqu.edu.cn/api/timetable/course/search-class-by-courseId";
const ADMIN_CLASS_SEARCH_URL =
  "https://my.cqu.edu.cn/api/timetable/admin-class/dept-admin-classes";
const DEPARTMENT_LIST_URL =
  "https://my.cqu.edu.cn/api/resourceapi/department/list";

const TABLE_DETAIL_URLS: Record<ExternalSourceType, string> = {
  instructor:
    "https://my.cqu.edu.cn/api/timetable/class/timetable/instructor/table-detail?sessionId={}",
  room: "https://my.cqu.edu.cn/api/timetable/class/timetable/room/table-detail?sessionId={}",
  laboratory:
    "https://my.cqu.edu.cn/api/timetable/class/timetable/room/table-detail?sessionId={}",
  course:
    "https://my.cqu.edu.cn/api/timetable/class/timetable/course/table-detail?sessionId={}",
  admin_class:
    "https://my.cqu.edu.cn/api/timetable/class/timetable/adminClass/table-detail?sessionId={}",
};

// Time slots (14 periods)
export const TIME_SLOTS: [string, string][] = [
  ["08:30:00", "09:15:00"],
  ["09:25:00", "10:10:00"],
  ["10:30:00", "11:15:00"],
  ["11:25:00", "12:10:00"],
  ["13:30:00", "14:15:00"],
  ["14:25:00", "15:10:00"],
  ["15:20:00", "16:05:00"],
  ["16:25:00", "17:10:00"],
  ["17:20:00", "18:05:00"],
  ["19:00:00", "19:45:00"],
  ["19:55:00", "20:40:00"],
  ["20:50:00", "21:35:00"],
  ["21:45:00", "22:30:00"],
  ["22:40:00", "23:25:00"],
];

export interface CourseEntry {
  name: string;
  lecturer: string;
  room: string;
  position: string;
  day_of_week: number;
  start_session: number;
  end_session: number;
  weeks: number[];
  experiment_name?: string;
}

export interface ExamEntry {
  name: string;
  room: string;
  seat: number;
  start_time: string;
  end_time: string;
}

export interface SessionInfo {
  id: string;
  name: string;
}

export interface SemesterInfo {
  id: string | null;
  name: string;
  begin_date: string | null;
  end_date: string | null;
}

export interface SearchResult {
  id: string;
  name: string;
  extra: string;
}

export interface DepartmentNode {
  id: string;
  name: string;
  children?: DepartmentNode[];
}

export class CQUAPIError extends Error {
  statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = "CQUAPIError";
    this.statusCode = statusCode;
  }
}

function formatUrl(template: string, value: string): string {
  return template.replace("{}", value);
}

const LECTURER_REGEX = /^(.*?)-\d/;
const ROOM_CODE_REGEX = /^[A-E][A-Z\d主理研二]\d/;

// ── CQU API response interfaces (key-path only) ────────────────────────────

export interface SessionListResponse {
  curSessionId?: string;
  sessionFinder?: Array<{ id?: string; name?: string }>;
}

export interface SessionDetailResponse {
  data?: {
    id?: string;
    year?: string;
    term?: string;
    beginDate?: string;
    endDate?: string;
  };
}

export interface ScheduleResponse {
  classTimetableVOList?: Array<{
    courseName?: string;
    instructorName?: string;
    roomName?: string;
    position?: string;
    campusName?: string;
    weekDay?: string | number;
    teachingWeek?: string;
    period?: string;
    exprProjectName?: string;
  }>;
}

export interface ExamListResponse {
  status?: string;
  data?: {
    content?: Array<{
      courseName?: string;
      examDate?: string;
      startTime?: string;
      endTime?: string;
      roomName?: string;
      seatNum?: string | number;
    }>;
  };
}

interface InstructorItem {
  id: string;
  name: string;
  departmentName?: string;
  code?: string;
}

interface RoomItem {
  id: string | number;
  name: string;
  capacity?: number | string;
}

interface LabItem {
  id: string | number;
  roomName?: string;
  campusName?: string;
  buildingName?: string;
}

interface CourseItem {
  id: string;
  name: string;
  number?: string;
  credit?: string | number;
}

interface CourseClassItem {
  id: string | number;
  classNbr?: string;
}

interface AdminClassItem {
  id: string | number;
  className?: string;
  grade?: string;
  personNumber?: number | string;
}

interface DepartmentRawItem {
  id: string | number;
  name: string;
  subDepartmentVOList?: DepartmentRawItem[];
}

/**
 * Decode the `user_name` claim (= the CQU 学号/student ID) from a CQU OAuth JWT
 * bearer token without verifying the signature.
 *
 * The CQU教务 access_token is a JWT whose payload carries `"user_name": "<学号>"`
 * (reverse-engineered: `cqu-api-endpoint-collection/systems/jwxt/notes.md`). This
 * claim is the authenticated subject of the bearer, so it is the trustworthy
 * "current logged-in user's own student ID" — it cannot be spoofed by a client.
 *
 * Returns `null` when the token is not a well-formed JWT or has no `user_name`.
 * The bearer itself is sensitive and is NEVER logged here.
 */
export function decodeStudentIdFromBearer(bearer: string): string | null {
  const parts = bearer.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64, then atob → JSON payload.
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(payloadB64);
    const payload = JSON.parse(json) as { user_name?: unknown };
    const userName = payload.user_name;
    if (typeof userName === "string" && userName.length > 0) {
      return userName;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a CQU `my-table-detail` (or `{type}/table-detail`) response into
 * {@link CourseEntry}[]. Pure — no I/O. Shared by the (retiring) CQUAPIClient
 * and the organic-harvest path so course parsing stays identical.
 */
export function parseCourses(data: ScheduleResponse): CourseEntry[] {
  const courses: CourseEntry[] = [];
  const timetableList = data.classTimetableVOList ?? [];

  for (const item of timetableList) {
    const teachingWeek: string = item.teachingWeek ?? "";
    const weeks: number[] = [];
    for (let i = 0; i < teachingWeek.length; i++) {
      if (teachingWeek[i] === "1") weeks.push(i + 1);
    }
    if (weeks.length === 0) continue;

    const period: string = item.period ?? "";
    if (!period) continue;

    const firstOne = period.indexOf("1");
    const lastOne = period.lastIndexOf("1");
    if (firstOne === -1) continue;

    const startSession = firstOne + 1;
    const endSession = lastOne + 1;

    let lecturer: string = item.instructorName ?? "";
    const lecturerMatch = LECTURER_REGEX.exec(lecturer);
    if (lecturerMatch) {
      lecturer = lecturerMatch[1];
    }

    const rawRoom = item.roomName ?? "";
    const rawPosition = item.position ?? item.campusName ?? "";
    let room: string;
    let position: string;

    if (ROOM_CODE_REGEX.test(rawRoom)) {
      room = rawRoom;
      position = rawPosition;
    } else if (ROOM_CODE_REGEX.test(rawPosition)) {
      room = rawPosition;
      position = rawRoom;
    } else {
      room = rawRoom;
      position = rawPosition;
      if (rawRoom || rawPosition) {
        console.warn(JSON.stringify({ event: "cqu_api.parse.unknown_room_format", roomName: rawRoom, position: rawPosition, course: item.courseName, message: "Neither roomName nor position matches room code pattern" }));
      }
    }

    const experimentName = item.exprProjectName?.trim() || undefined;

    courses.push({
      name: item.courseName ?? "",
      lecturer,
      room,
      position,
      day_of_week: Number(item.weekDay ?? 1),
      start_session: startSession,
      end_session: endSession,
      weeks,
      ...(experimentName ? { experiment_name: experimentName } : {}),
    });
  }

  return courses;
}

/**
 * Parse a CQU `get-student-exam-list` response into {@link ExamEntry}[]. Pure.
 * Shared by the (retiring) CQUAPIClient and the organic-harvest path.
 */
export function parseExams(data: ExamListResponse): ExamEntry[] {
  const exams: ExamEntry[] = [];

  if (data.status !== "success") return [];

  const examList = data.data?.content ?? [];

  for (const item of examList) {
    try {
      const examDateStr: string = item.examDate ?? "";
      const startTimeStr: string = item.startTime ?? "";
      const endTimeStr: string = item.endTime ?? "";

      if (!examDateStr || !startTimeStr || !endTimeStr) continue;

      const examDate = new Date(examDateStr);
      if (isNaN(examDate.getTime())) continue;

      const [startH, startM] = startTimeStr.split(":").map(Number);
      const [endH, endM] = endTimeStr.split(":").map(Number);

      const year = examDate.getFullYear();
      const month = examDate.getMonth();
      const day = examDate.getDate();

      const startDt = new Date(
        Date.UTC(year, month, day, startH, startM) - CHINA_TZ_OFFSET_MS,
      );
      const endDt = new Date(
        Date.UTC(year, month, day, endH, endM) - CHINA_TZ_OFFSET_MS,
      );

      const seatNum = Number(item.seatNum ?? 0) || 0;

      exams.push({
        name: `${item.courseName ?? ""}考试`,
        room: item.roomName ?? "",
        seat: seatNum,
        start_time: formatChinaIso(startDt),
        end_time: formatChinaIso(endDt),
      });
    } catch {
      // skip invalid exam data
    }
  }

  return exams;
}

export class CQUAPIClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Resolve the student ID of the bearer's own authenticated subject.
   *
   * Decodes the `user_name` claim of the bearer JWT (see
   * {@link decodeStudentIdFromBearer}). This is request-free and tamper-proof:
   * the value is bound to the bearer, never to client-supplied input.
   *
   * @throws {CQUAPIError} when the bearer carries no usable student ID.
   */
  getOwnStudentId(): string {
    const studentId = decodeStudentIdFromBearer(this.accessToken);
    if (!studentId) {
      throw new CQUAPIError("无法从 bearer 解析学号", 401);
    }
    return studentId;
  }

  private async request<T = unknown>(
    method: string,
    url: string,
    options?: { json?: unknown; params?: Record<string, string | number>; timeout?: number },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    };

    let finalUrl = url;
    if (options?.params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        searchParams.set(k, String(v));
      }
      finalUrl += (url.includes("?") ? "&" : "?") + searchParams.toString();
    }

    const timeoutMs = options?.timeout ?? 30000;

    const doFetch = async (): Promise<Response> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (options?.json !== undefined) {
        init.body = JSON.stringify(options.json);
      }
      try {
        return await fetch(finalUrl, init);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          throw new CQUAPIError(`Request timed out (${timeoutMs / 1000}s)`, 408);
        }
        throw new CQUAPIError(`Network error: ${e}`);
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let response: Response;
    try {
      response = await doFetch();
    } catch (e) {
      if (e instanceof CQUAPIError && e.statusCode === 408) {
        response = await doFetch();
      } else {
        throw e;
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new CQUAPIError("Access Token 无效或已过期", 401);
      }
      throw new CQUAPIError(
        `Request failed: HTTP ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  async getSessionList(): Promise<{
    current_session_id: string;
    sessions: Record<string, SessionInfo>;
  }> {
    const data = await this.request<SessionListResponse>("GET", SESSION_LIST_URL);

    const curSessionId: string = data.curSessionId ?? "";
    const sessionFinder = data.sessionFinder ?? [];

    const sessions: Record<string, SessionInfo> = {};
    for (const item of sessionFinder) {
      if (item?.id && item?.name) {
        sessions[item.id] = { id: item.id, name: item.name };
      }
    }

    return { current_session_id: curSessionId, sessions };
  }

  async getSemesterInfo(termId: string): Promise<SemesterInfo> {
    const url = formatUrl(SESSION_DETAIL_URL_TEMPLATE, termId);
    const jsonData = await this.request<SessionDetailResponse>("GET", url);

    const data = jsonData.data ?? {};
    const beginDate: string = data.beginDate ?? "";
    const endDate: string = data.endDate ?? "";

    return {
      id: data.id ?? null,
      name: `${data.year ?? ""}${data.term ?? ""}`,
      begin_date: beginDate ? beginDate.split(" ")[0] : null,
      end_date: endDate ? endDate.split(" ")[0] : null,
    };
  }

  async getSchedule(
    studentId: string,
    termId: string,
  ): Promise<CourseEntry[]> {
    const url = formatUrl(SCHEDULE_URL_TEMPLATE, termId);
    const data = await this.request<ScheduleResponse>("POST", url, { json: [studentId] });
    return this.parseCourses(data);
  }

  private parseCourses(data: ScheduleResponse): CourseEntry[] {
    return parseCourses(data);
  }

  async getExams(): Promise<ExamEntry[]> {
    const data = await this.request<ExamListResponse>("GET", EXAM_URL);
    return this.parseExams(data);
  }

  private parseExams(data: ExamListResponse): ExamEntry[] {
    return parseExams(data);
  }

  // ── Search methods ──

  async searchInstructor(keyword: string): Promise<SearchResult[]> {
    const data = await this.request<InstructorItem[]>("GET", INSTRUCTOR_SEARCH_URL, {
      params: { nameOrCode: keyword, limitNum: 50 },
    });
    return data.map((item) => ({
      id: item.id,
      name: item.name,
      extra: `${item.departmentName ?? ""} / ${item.code ?? ""}`,
    }));
  }

  async searchRoom(keyword: string): Promise<SearchResult[]> {
    const data = await this.request<RoomItem[]>("GET", ROOM_SEARCH_URL, {
      params: { roomName: keyword, limitNum: 200 },
    });
    return data.map((item) => ({
      id: String(item.id),
      name: item.name,
      extra: `容量: ${item.capacity ?? "未知"}`,
    }));
  }

  async searchLaboratory(keyword: string): Promise<SearchResult[]> {
    const data = await this.request<LabItem[]>("GET", LAB_SEARCH_URL, {
      params: { roomName: keyword, limitNum: 200 },
    });
    return data.map((item) => ({
      id: String(item.id),
      name: item.roomName ?? "",
      extra: `${item.campusName ?? ""} / ${item.buildingName ?? ""}`,
    }));
  }

  async searchCourse(
    keyword: string,
    sessionId: string,
  ): Promise<SearchResult[]> {
    const courseData = await this.request<CourseItem[] | { data?: CourseItem[] }>("GET", COURSE_SEARCH_URL, {
      params: { nameOrCode: keyword, pageSize: 50, sessionId },
    });

    const courses: CourseItem[] = (
      typeof courseData === "object" && !Array.isArray(courseData)
        ? courseData.data ?? []
        : courseData
    ).slice(0, 10);

    const results: SearchResult[] = [];

    // Fetch classes for each course in parallel
    const classPromises = courses.map(async (course) => {
      try {
        const classes = await this.request<CourseClassItem[]>("GET", COURSE_CLASS_SEARCH_URL, {
          params: { courseId: course.id, sessionId },
        });
        return classes.map((cls) => ({
          id: String(cls.id),
          name: `${course.name} (${cls.classNbr ?? ""})`,
          extra: `课程代码: ${course.number ?? ""} / 学分: ${course.credit ?? ""}`,
        }));
      } catch {
        return [];
      }
    });

    const classLists = await Promise.all(classPromises);
    for (const list of classLists) {
      results.push(...list);
    }

    return results;
  }

  async searchAdminClass(
    departmentId: string,
    grade?: string,
    className?: string,
  ): Promise<SearchResult[]> {
    const params: Record<string, string | number> = { pageSize: 200 };
    if (grade) params.grade = grade;
    if (className) params.className = className;

    const data = await this.request<AdminClassItem[]>("POST", ADMIN_CLASS_SEARCH_URL, {
      params,
      json: [departmentId],
    });

    return data.map((item) => ({
      id: String(item.id),
      name: item.className ?? "",
      extra: `${item.grade ?? ""}级 / ${item.personNumber ?? ""}人`,
    }));
  }

  async getDepartments(): Promise<DepartmentNode[]> {
    const data = await this.request<DepartmentRawItem[] | { data?: DepartmentRawItem[] }>("GET", DEPARTMENT_LIST_URL);
    const items: DepartmentRawItem[] =
      typeof data === "object" && !Array.isArray(data)
        ? data.data ?? []
        : data;
    return items.map(formatDepartment);
  }

  async fetchTargetSchedule(
    sourceType: ExternalSourceType,
    sourceId: string,
    sessionId: string,
  ): Promise<CourseEntry[]> {
    const urlTemplate = TABLE_DETAIL_URLS[sourceType];
    if (!urlTemplate) {
      throw new CQUAPIError(`Unknown source_type: ${sourceType}`, 400);
    }
    const url = formatUrl(urlTemplate, sessionId);
    const data = await this.request<ScheduleResponse>("POST", url, { json: [sourceId], timeout: 60000 });
    return this.parseCourses(data);
  }
}

function formatDepartment(item: DepartmentRawItem): DepartmentNode {
  const result: DepartmentNode = {
    id: String(item.id),
    name: item.name,
  };
  const subs = item.subDepartmentVOList ?? [];
  if (subs.length > 0) {
    result.children = subs.map(formatDepartment);
  }
  return result;
}
