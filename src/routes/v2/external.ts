import { Hono } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { rateLimit } from "../../middleware/rate-limit";
import { assertFlag, EntitlementError } from "../../middleware/entitlements";
import { getCquBearer } from "../../services/cqu-bearer";
import { CQUAPIClient, CQUAPIError, type SearchResult } from "../../services/cqu-api";
import { errorResponse, handleCquApiError } from "../../utils/error";

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

// ── GET /search — search external (public) timetable sources ──────────────────
//  Gated by the `external` calendar cap and the EXTERNAL_LIMITER rate limit. The
//  CQU教务 bearer is minted per-user via getCquBearer (拓扑①); a null bearer means
//  the user's CQU session is not bound/ready → 409 (re-login/bind required).
app.get("/search", rateLimit("EXTERNAL_LIMITER"), async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;

  try {
    assertFlag(caps, "external", "外部订阅");
  } catch (e) {
    return entitlementError(e);
  }

  const sourceType = c.req.query("source_type") ?? "";
  const keyword = c.req.query("keyword") ?? "";
  const sessionId = c.req.query("session_id") ?? "";
  const departmentId = c.req.query("department_id") ?? "";
  const grade = c.req.query("grade") ?? "";

  if (!keyword.trim()) {
    return errorResponse("BAD_REQUEST", "keyword 必填", 400);
  }
  if (keyword.length > KEYWORD_MAX_LEN) {
    return errorResponse("BAD_REQUEST", `keyword 长度不能超过 ${KEYWORD_MAX_LEN}`, 400);
  }

  const bearer = await getCquBearer(c.env, user.id);
  if (!bearer) {
    console.log(
      JSON.stringify({
        event: "external.v2.search.skip_no_bearer",
        userId: user.id,
        message: "No CQU bearer available; session inactive",
      }),
    );
    return errorResponse("CQU_SESSION_INACTIVE", "CQU 会话未就绪，请重新登录或绑定 CQU", 409);
  }

  const api = new CQUAPIClient(bearer);

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
    if (e instanceof CQUAPIError) return handleCquApiError(c, e, "Search failed");
    throw e;
  }
});

// ── GET /departments — department tree for admin_class search drill-down ──────
app.get("/departments", rateLimit("EXTERNAL_LIMITER"), async (c) => {
  const user = c.get("user");
  const caps = c.get("caps").calendar;

  try {
    assertFlag(caps, "external", "外部订阅");
  } catch (e) {
    return entitlementError(e);
  }

  const bearer = await getCquBearer(c.env, user.id);
  if (!bearer) {
    console.log(
      JSON.stringify({
        event: "external.v2.departments.skip_no_bearer",
        userId: user.id,
        message: "No CQU bearer available; session inactive",
      }),
    );
    return errorResponse("CQU_SESSION_INACTIVE", "CQU 会话未就绪，请重新登录或绑定 CQU", 409);
  }

  const api = new CQUAPIClient(bearer);

  try {
    const departments = await api.getDepartments();
    return c.json({ departments });
  } catch (e) {
    if (e instanceof CQUAPIError) return handleCquApiError(c, e, "Failed to load departments");
    throw e;
  }
});

export default app;
