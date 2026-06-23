import { Hono, type Context } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, EntitlementError } from "../../middleware/entitlements";
import { CQUAPIClient, CQUAPIError, type SearchResult } from "../../services/cqu-api";
import { errorResponse, handleCquApiError } from "../../utils/error";
import { externalUnavailableResponse } from "../../config/external-availability";

const app = new Hono<SessionEnv>();

/** Max length for a search keyword. */
const KEYWORD_MAX_LEN = 100;

/** Map an EntitlementError to a JSON error response; rethrow anything else. */
function entitlementError(e: unknown): Response {
  if (e instanceof EntitlementError) {
    return errorResponse(e.code, e.message, e.status);
  }
  throw e;
}

// ── Shared preamble for external (CQU教务) routes ──────────────────────────────
//  Enforces the `external` calendar cap, then short-circuits with a 503 while
//  external schedules are soft-disabled (no organic-harvest 过墙 path for the
//  external {type}/table-detail POST). Kept returning `CQUAPIClient | Response`
//  so the call sites are ready to re-enable once an external harvest path lands.
//  Rate limiting stays as route-level middleware and is NOT handled here.
async function externalApiOrError(c: Context<SessionEnv>): Promise<CQUAPIClient | Response> {
  const caps = c.get("caps").calendar;

  try {
    assertFlag(caps, "external", "外部订阅");
  } catch (e) {
    return entitlementError(e);
  }

  // External schedules are soft-disabled while只有 personal 课表 has an organic-
  // harvest 过墙 path (the external {type}/table-detail POST is瑞数 写专守). Return
  // a neutral "unavailable" without exposing WAF internals — the single reversible
  // source of truth is `EXTERNAL_DISABLED` in src/config/external-availability.ts.
  // When that flag flips to false, this returns null and the handler falls through
  // to the live CQU教务 path again.
  const unavailable = externalUnavailableResponse();
  if (unavailable) return unavailable;

  // External re-enabled but no harvest path wired yet — keep the route fail-safe.
  return errorResponse("EXTERNAL_UNAVAILABLE", "外部课表暂不可用", 503);
}

// ── GET /search — search external (public) timetable sources ──────────────────
//  Gated by the `external` calendar cap. EXTERNAL_LIMITER is applied at the mount
//  (before sessionMiddleware), not here. Currently soft-disabled: externalApiOrError
//  returns 503 EXTERNAL_UNAVAILABLE before any CQU教务 call.
app.get("/search", async (c) => {
  // 外部课表软禁用(可逆):在 cap/输入校验/CQU 调用之前短路返回暂不可用,不暴露 WAF。
  const unavailable = externalUnavailableResponse();
  if (unavailable) return unavailable;

  const sourceType = c.req.query("source_type") ?? "";
  const keyword = c.req.query("keyword") ?? "";
  const sessionId = c.req.query("session_id") ?? "";
  const departmentId = c.req.query("department_id") ?? "";
  const grade = c.req.query("grade") ?? "";

  // admin_class browses a whole department, so its keyword (class name) is
  // optional — the frontend searches as soon as a department is picked. All
  // other source types require a keyword.
  if (sourceType !== "admin_class" && !keyword.trim()) {
    return errorResponse("BAD_REQUEST", "keyword 必填", 400);
  }
  if (keyword.length > KEYWORD_MAX_LEN) {
    return errorResponse("BAD_REQUEST", `keyword 长度不能超过 ${KEYWORD_MAX_LEN}`, 400);
  }
  if (sourceType === "admin_class" && !departmentId.trim()) {
    return errorResponse("BAD_REQUEST", "department_id 必填", 400);
  }

  const api = await externalApiOrError(c);
  if (api instanceof Response) return api;

  try {
    let results: SearchResult[];
    switch (sourceType) {
      case "instructor":
        results = await api.searchInstructor(keyword);
        break;
      case "room":
        results = await api.searchRoom(keyword);
        break;
      case "laboratory":
        results = await api.searchLaboratory(keyword);
        break;
      case "course": {
        let csid = sessionId;
        if (!csid) {
          csid = (await api.getSessionList()).current_session_id;
        }
        results = await api.searchCourse(keyword, csid);
        break;
      }
      case "admin_class":
        results = await api.searchAdminClass(departmentId, grade, keyword);
        break;
      default:
        return errorResponse("BAD_REQUEST", "Invalid source_type", 400);
    }
    return c.json({ results });
  } catch (e) {
    if (e instanceof CQUAPIError) {
      return handleCquApiError(c, e, "Search failed");
    }
    throw e;
  }
});

// ── GET /departments — department tree for admin_class search drill-down ──────
//  EXTERNAL_LIMITER applied at the mount (before sessionMiddleware), not here.
app.get("/departments", async (c) => {
  // 外部课表软禁用(可逆):在 cap/CQU 调用之前短路返回暂不可用,不暴露 WAF。
  const unavailable = externalUnavailableResponse();
  if (unavailable) return unavailable;

  const api = await externalApiOrError(c);
  if (api instanceof Response) return api;

  try {
    const departments = await api.getDepartments();
    return c.json({ departments });
  } catch (e) {
    if (e instanceof CQUAPIError) {
      return handleCquApiError(c, e, "Failed to load departments");
    }
    throw e;
  }
});

export default app;
