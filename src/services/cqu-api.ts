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

const TABLE_DETAIL_URLS: Record<string, string> = {
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

// China timezone offset in ms
const CHINA_TZ_OFFSET = 8 * 60 * 60 * 1000;

export interface CourseEntry {
  name: string;
  lecturer: string;
  room: string;
  position: string;
  day_of_week: number;
  start_session: number;
  end_session: number;
  weeks: number[];
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

export class CQUAPIClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request(
    method: string,
    url: string,
    options?: { json?: unknown; params?: Record<string, string | number> },
  ): Promise<any> {
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

    const init: RequestInit = {
      method,
      headers,
    };
    if (options?.json !== undefined) {
      init.body = JSON.stringify(options.json);
    }

    let response: Response;
    try {
      response = await fetch(finalUrl, init);
    } catch (e) {
      throw new CQUAPIError(`Network error: ${e}`);
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

    return response.json();
  }

  async getSessionList(): Promise<{
    current_session_id: string;
    sessions: Record<string, SessionInfo>;
  }> {
    const data = await this.request("GET", SESSION_LIST_URL);

    const curSessionId: string = data.curSessionId ?? "";
    const sessionFinder: any[] = data.sessionFinder ?? [];

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
    const jsonData = await this.request("GET", url);

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
    const data = await this.request("POST", url, { json: [studentId] });
    return this.parseCourses(data);
  }

  private parseCourses(data: any): CourseEntry[] {
    const courses: CourseEntry[] = [];
    const timetableList: any[] = data.classTimetableVOList ?? [];

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

      courses.push({
        name: item.courseName ?? "",
        lecturer,
        room: item.roomName ?? "",
        position: item.position ?? item.campusName ?? "",
        day_of_week: Number(item.weekDay ?? 1),
        start_session: startSession,
        end_session: endSession,
        weeks,
      });
    }

    return courses;
  }

  async getExams(): Promise<ExamEntry[]> {
    const data = await this.request("GET", EXAM_URL);
    return this.parseExams(data);
  }

  private parseExams(data: any): ExamEntry[] {
    const exams: ExamEntry[] = [];

    if (data.status !== "success") return [];

    const examList: any[] = data.data?.content ?? [];

    for (const item of examList) {
      try {
        const examDateStr: string = item.examDate ?? "";
        const startTimeStr: string = item.startTime ?? "";
        const endTimeStr: string = item.endTime ?? "";

        if (!examDateStr || !startTimeStr || !endTimeStr) continue;

        // Parse exam date (ISO format from API)
        const examDate = new Date(examDateStr);
        if (isNaN(examDate.getTime())) continue;

        // Parse HH:MM time strings
        const [startH, startM] = startTimeStr.split(":").map(Number);
        const [endH, endM] = endTimeStr.split(":").map(Number);

        // Create China timezone datetimes
        // Construct UTC times representing China local time
        const year = examDate.getFullYear();
        const month = examDate.getMonth();
        const day = examDate.getDate();

        const startDt = new Date(
          Date.UTC(year, month, day, startH, startM) - CHINA_TZ_OFFSET,
        );
        const endDt = new Date(
          Date.UTC(year, month, day, endH, endM) - CHINA_TZ_OFFSET,
        );

        let seatNum = 0;
        try {
          seatNum = Number(item.seatNum ?? 0) || 0;
        } catch {
          // ignore
        }

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

  // ── Search methods ──

  async searchInstructor(keyword: string): Promise<SearchResult[]> {
    const data = await this.request("GET", INSTRUCTOR_SEARCH_URL, {
      params: { nameOrCode: keyword, limitNum: 50 },
    });
    return (data as any[]).map((item) => ({
      id: item.id,
      name: item.name,
      extra: `${item.departmentName ?? ""} / ${item.code ?? ""}`,
    }));
  }

  async searchRoom(keyword: string): Promise<SearchResult[]> {
    const data = await this.request("GET", ROOM_SEARCH_URL, {
      params: { roomName: keyword, limitNum: 200 },
    });
    return (data as any[]).map((item) => ({
      id: String(item.id),
      name: item.name,
      extra: `容量: ${item.capacity ?? "未知"}`,
    }));
  }

  async searchLaboratory(keyword: string): Promise<SearchResult[]> {
    const data = await this.request("GET", LAB_SEARCH_URL, {
      params: { roomName: keyword, limitNum: 200 },
    });
    return (data as any[]).map((item) => ({
      id: String(item.id),
      name: item.roomName ?? "",
      extra: `${item.campusName ?? ""} / ${item.buildingName ?? ""}`,
    }));
  }

  async searchCourse(
    keyword: string,
    sessionId: string,
  ): Promise<SearchResult[]> {
    const courseData = await this.request("GET", COURSE_SEARCH_URL, {
      params: { nameOrCode: keyword, pageSize: 50, sessionId },
    });

    const courses: any[] = (
      typeof courseData === "object" && !Array.isArray(courseData)
        ? courseData.data ?? []
        : courseData
    ).slice(0, 10);

    const results: SearchResult[] = [];

    // Fetch classes for each course in parallel
    const classPromises = courses.map(async (course) => {
      try {
        const classes = await this.request("GET", COURSE_CLASS_SEARCH_URL, {
          params: { courseId: course.id, sessionId },
        });
        return (classes as any[]).map((cls: any) => ({
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

    const data = await this.request("POST", ADMIN_CLASS_SEARCH_URL, {
      params,
      json: [departmentId],
    });

    return (data as any[]).map((item) => ({
      id: String(item.id),
      name: item.className ?? "",
      extra: `${item.grade ?? ""}级 / ${item.personNumber ?? ""}人`,
    }));
  }

  async getDepartments(): Promise<DepartmentNode[]> {
    const data = await this.request("GET", DEPARTMENT_LIST_URL);
    const items: any[] =
      typeof data === "object" && !Array.isArray(data)
        ? data.data ?? []
        : data;
    return items.map(formatDepartment);
  }

  async fetchTargetSchedule(
    sourceType: string,
    sourceId: string,
    sessionId: string,
  ): Promise<CourseEntry[]> {
    const urlTemplate = TABLE_DETAIL_URLS[sourceType];
    if (!urlTemplate) {
      throw new CQUAPIError(`Unknown source_type: ${sourceType}`, 400);
    }
    const url = formatUrl(urlTemplate, sessionId);
    const data = await this.request("POST", url, { json: [sourceId] });
    return this.parseCourses(data);
  }
}

function formatChinaIso(utcDate: Date): string {
  // Format as ISO with +08:00 offset
  const china = new Date(utcDate.getTime() + CHINA_TZ_OFFSET);
  const y = china.getUTCFullYear();
  const mo = String(china.getUTCMonth() + 1).padStart(2, "0");
  const d = String(china.getUTCDate()).padStart(2, "0");
  const h = String(china.getUTCHours()).padStart(2, "0");
  const mi = String(china.getUTCMinutes()).padStart(2, "0");
  const s = String(china.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
}

function formatDepartment(item: any): DepartmentNode {
  const result: DepartmentNode = {
    id: String(item.id),
    name: item.name,
  };
  const subs: any[] = item.subDepartmentVOList ?? [];
  if (subs.length > 0) {
    result.children = subs.map(formatDepartment);
  }
  return result;
}
