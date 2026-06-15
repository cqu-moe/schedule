import { Hono, type Context } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { assertFlag, EntitlementError } from "../../middleware/entitlements";
import { getCquBearer, invalidateCquBearer } from "../../services/cqu-bearer";
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

// ── Shared bearer preamble for external (CQU教务) routes ────────────────────────
//  Enforces the `external` calendar cap and mints the per-user CQU bearer
//  (拓扑①). Returns either a ready CQUAPIClient, or a Response to short-circuit
//  the route (403 if the cap is missing, 409 if the CQU session is not ready).
//  Rate limiting stays as route-level middleware and is NOT handled here.
async function externalApiOrError(c: Context<SessionEnv>): Promise<CQUAPIClient | Response> {
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
        event: "external.v2.skip_no_bearer",
        userId: user.id,
        message: "No CQU bearer; user must (re)bind CQU",
      }),
    );
    return errorResponse("CQU_SESSION_INACTIVE", "CQU 会话未就绪，请重新登录或绑定 CQU", 409);
  }

  return new CQUAPIClient(bearer);
}

// ── GET /search — search external (public) timetable sources ──────────────────
//  Gated by the `external` calendar cap. EXTERNAL_LIMITER is applied at the mount
//  (before sessionMiddleware), not here. The CQU教务 bearer is minted per-user via
//  getCquBearer (拓扑①); a null bearer means the user's CQU session is not
//  bound/ready → 409 (re-login/bind required).
app.get("/search", async (c) => {
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
      // 401 → bearer rejected by CQU; drop it so the next request re-mints.
      if (e.statusCode === 401) await invalidateCquBearer(c.env, c.get("user").id);
      return handleCquApiError(c, e, "Search failed");
    }
    throw e;
  }
});

// ── GET /departments — department tree for admin_class search drill-down ──────
//  EXTERNAL_LIMITER applied at the mount (before sessionMiddleware), not here.
app.get("/departments", async (c) => {
  const api = await externalApiOrError(c);
  if (api instanceof Response) return api;

  try {
    const departments = await api.getDepartments();
    return c.json({ departments });
  } catch (e) {
    if (e instanceof CQUAPIError) {
      if (e.statusCode === 401) await invalidateCquBearer(c.env, c.get("user").id);
      return handleCquApiError(c, e, "Failed to load departments");
    }
    throw e;
  }
});

export default app;
