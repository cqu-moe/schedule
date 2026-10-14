import { Hono, type Context } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, EntitlementError } from "../../middleware/entitlements";
import { externalAvailability } from "../../config/external-availability";
import { findDepartment, searchExternal } from "../../services/external-search";
import { errorResponse } from "../../utils/error";

const app = new Hono<SessionEnv>();

function authorize(c: Context<SessionEnv>): Response | null {
  if (!externalAvailability(c.env).search_types.includes("admin_class")) {
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
  if (sourceType !== "admin_class") return errorResponse("BAD_REQUEST", "暂不支持此课表来源", 400);
  if (c.req.query("session_id") !== undefined) return errorResponse("BAD_REQUEST", "仅支持学校当前学期", 400);
  const keyword = (c.req.query("keyword") ?? "").trim();
  const departmentId = c.req.query("department_id") ?? "";
  const grade = c.req.query("grade") ?? "";
  if (keyword.length > 100 || departmentId.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword + departmentId) || (grade !== "" && !/^(?:19|20)\d{2}$/.test(grade))) {
    return errorResponse("BAD_REQUEST", "搜索条件格式不正确", 400);
  }
  const userId = c.get("user").id;
  let departmentName = "";
  if (departmentId) {
    const directory = await searchExternal(c.env, userId, { sourceType: "department" });
    if (directory instanceof Response) return directory;
    if (directory.sourceType !== "department") return errorResponse("EXTERNAL_INVALID_RESPONSE", "院系信息暂不可用", 502);
    const department = findDepartment(directory.departments, departmentId);
    if (!department) return errorResponse("BAD_REQUEST", "请选择当前院系列表中的学院", 400);
    departmentName = department.name;
  }
  const result = await searchExternal(c.env, userId, { sourceType, keyword, departmentId, departmentName, grade });
  if (result instanceof Response) return result;
  if (result.sourceType !== "admin_class") return errorResponse("EXTERNAL_INVALID_RESPONSE", "搜索结果暂不可用", 502);
  return c.json({ session: result.session, results: result.items, truncated: result.truncated });
});

app.get("/departments", async (c) => {
  const denied = authorize(c);
  if (denied) return denied;
  if (c.req.query("session_id") !== undefined) return errorResponse("BAD_REQUEST", "仅支持学校当前学期", 400);
  const result = await searchExternal(c.env, c.get("user").id, { sourceType: "department" });
  if (result instanceof Response) return result;
  if (result.sourceType !== "department") return errorResponse("EXTERNAL_INVALID_RESPONSE", "院系信息暂不可用", 502);
  return c.json({ session: result.session, departments: result.departments });
});

export default app;
