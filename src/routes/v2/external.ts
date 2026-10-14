import { Hono, type Context } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, EntitlementError } from "../../middleware/entitlements";
import { externalAvailability } from "../../config/external-availability";
import { findDepartment, searchExternal } from "../../services/external-search";
import { issueExternalSelection, resolveExternalCourseSelection } from "../../services/external-target";
import { expireCourseSubscriptions, type CourseTermObservation } from "../../services/external-term";
import type { Env } from "../../types";
import { errorResponse } from "../../utils/error";

const app = new Hono<SessionEnv>();

/** A cached directory is not a new term observation. Fence fresh replies to the
 * targets seen before the school request so late replies cannot expire a reselection. */
async function searchCurrentTerm(env: Env, userId: string, input: Parameters<typeof searchExternal>[2]) {
  const observed = await env.DB.prepare(`SELECT id,target_revision,session_id FROM subscriptions
    WHERE user_id=? AND source_version=1 AND source_type='course' AND external_state IN ('active','reselecting')`)
    .bind(userId).all<CourseTermObservation>();
  return searchExternal(env, userId, input, {
    onFreshSession: async (session) => {
      const stale = observed.results.filter(target => target.session_id !== null && target.session_id !== session.id);
      if (stale.length) await expireCourseSubscriptions(env.DB, userId, session.id, { observedTargets: stale });
    },
  });
}

function authorize(c: Context<SessionEnv>): Response | null {
  if (externalAvailability(c.env, c.get("user").id).search_types.length === 0) {
    return errorResponse("EXTERNAL_UNAVAILABLE", "外部订阅功能暂不可用", 503);
  }
  try { assertFlag(c.get("caps").calendar, "external", "外部订阅"); }
  catch (error) {
    if (error instanceof EntitlementError) return errorResponse(error.code, error.message, error.status);
    throw error;
  }
  const binding = c.get("cquBindStatus");
  if (binding === undefined) return errorResponse("EXTERNAL_UNAVAILABLE", "暂时无法确认学校绑定状态，请稍后重试", 503);
  if (binding !== "active") return errorResponse("CQU_SESSION_INACTIVE", "请先绑定有效的重庆大学统一认证账号", 409);
  return null;
}

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

app.get("/search", async (c) => {
  const denied = authorize(c);
  if (denied) return denied;
  const sourceType = c.req.query("source_type");
  if ((sourceType !== "admin_class" && sourceType !== "instructor" && sourceType !== "room" && sourceType !== "laboratory" && sourceType !== "course") || !externalAvailability(c.env, c.get("user").id).search_types.includes(sourceType)) return errorResponse("BAD_REQUEST", "暂不支持此课表来源", 400);
  if (c.req.query("session_id") !== undefined) return errorResponse("BAD_REQUEST", "仅支持学校当前学期", 400);
  const keyword = (c.req.query("keyword") ?? "").trim();
  const departmentId = c.req.query("department_id") ?? "";
  const grade = c.req.query("grade") ?? "";
  if (keyword.length > 100 || departmentId.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword + departmentId) || (grade !== "" && !/^(?:19|20)\d{2}$/.test(grade))) {
    return errorResponse("BAD_REQUEST", "搜索条件格式不正确", 400);
  }
  if (sourceType !== "admin_class" && (departmentId || grade)) return errorResponse("BAD_REQUEST", "此来源不支持院系或年级筛选", 400);
  const userId = c.get("user").id;
  let departmentName = "";
  if (departmentId) {
    const directory = await searchCurrentTerm(c.env, userId, { sourceType: "department" });
    if (directory instanceof Response) return directory;
    if (directory.sourceType !== "department") return errorResponse("EXTERNAL_INVALID_RESPONSE", "院系信息暂不可用", 502);
    const department = findDepartment(directory.departments, departmentId);
    if (!department) return errorResponse("BAD_REQUEST", "请选择当前院系列表中的学院", 400);
    departmentName = department.name;
  }
  const queryType = sourceType === "course" ? "course_catalog" : sourceType;
  const result = await searchCurrentTerm(c.env, userId, sourceType === "course"
    ? { sourceType: "course_catalog", keyword }
    : { sourceType: queryType, keyword, departmentId, departmentName, grade });
  if (result instanceof Response) return result;
  if (result.sourceType !== queryType) return errorResponse("EXTERNAL_INVALID_RESPONSE", "搜索结果暂不可用", 502);
  const selectionToken = await issueExternalSelection(c.env, userId, result).catch(() => null);
  if (!selectionToken) return errorResponse("EXTERNAL_UNAVAILABLE", "暂时无法保存搜索结果，请稍后重试", 503);
  return c.json({ session: result.session, results: result.items, truncated: result.truncated, selection_token: selectionToken, ...(sourceType === "course" ? { stage: "courses" } : {}) });
});

app.get("/teaching-classes", async (c) => {
  const denied = authorize(c);
  if (denied) return denied;
  if (!externalAvailability(c.env, c.get("user").id).search_types.includes("course")) return errorResponse("EXTERNAL_UNAVAILABLE", "教学班订阅暂不可用", 503);
  if (c.req.query("session_id") !== undefined) return errorResponse("BAD_REQUEST", "仅支持学校当前学期", 400);
  const userId = c.get("user").id;
  try {
    const selected = await resolveExternalCourseSelection(c.env, userId, c.req.query("selection_token"), c.req.query("course_id"));
    const result = await searchCurrentTerm(c.env, userId, { sourceType: "course", courseId: selected.course.id,
      courseName: selected.course.name, expectedSessionId: selected.session.id });
    if (result instanceof Response) return result;
    if (result.sourceType !== "course" || result.course.id !== selected.course.id || result.course.name !== selected.course.name || result.session.id !== selected.session.id) {
      return errorResponse("EXTERNAL_SELECTION_EXPIRED", "课程或当前学期已变化，请重新选择", 409);
    }
    const selectionToken = await issueExternalSelection(c.env, userId, result);
    return c.json({ session: result.session, course: result.course, stage: "classes", results: result.items, truncated: result.truncated, selection_token: selectionToken });
  } catch (error) {
    if (error instanceof EntitlementError) return errorResponse(error.code, error.message, error.status);
    return errorResponse("EXTERNAL_UNAVAILABLE", "暂时无法查询教学班，请稍后重试", 503);
  }
});

app.get("/departments", async (c) => {
  const denied = authorize(c);
  if (denied) return denied;
  if (c.req.query("session_id") !== undefined) return errorResponse("BAD_REQUEST", "仅支持学校当前学期", 400);
  const result = await searchCurrentTerm(c.env, c.get("user").id, { sourceType: "department" });
  if (result instanceof Response) return result;
  if (result.sourceType !== "department") return errorResponse("EXTERNAL_INVALID_RESPONSE", "院系信息暂不可用", 502);
  return c.json({ session: result.session, departments: result.departments });
});

export default app;
