import { Hono } from "hono";
import type { Env } from "../types";
import type { User } from "../db/schema";
import { requireAuthWithCquToken } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { CQUAPIClient, CQUAPIError } from "../services/cqu-api";
import { decrypt } from "../services/crypto";

type AuthEnv = { Bindings: Env; Variables: { user: User } };

const app = new Hono<AuthEnv>();

// GET /api/v1/search
app.get("/search", requireAuthWithCquToken, rateLimit("EXPLORE_LIMITER"), async (c) => {
  const sourceType = c.req.query("source_type") ?? "";
  const keyword = c.req.query("keyword") ?? "";
  if (keyword.length > 100) {
    return c.json(
      { detail: "keyword must not exceed 100 characters" },
      400,
    );
  }
  const sessionId = c.req.query("session_id") ?? "";
  const departmentId = c.req.query("department_id") ?? "";
  const grade = c.req.query("grade") ?? "";

  const user = c.get("user");
  const accessToken = await decrypt(user.accessToken!, c.env.ENCRYPTION_KEY);
  const api = new CQUAPIClient(accessToken);

  try {
    let results;
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
        let courseSessionId = sessionId;
        if (!courseSessionId) {
          const sessionList = await api.getSessionList();
          courseSessionId = sessionList.current_session_id;
        }
        results = await api.searchCourse(keyword, courseSessionId);
        break;
      }
      case "admin_class":
        results = await api.searchAdminClass(departmentId, grade, keyword);
        break;
      default:
        return c.json({ detail: "Invalid source_type" }, 400);
    }
    return c.json({ results });
  } catch (e) {
    if (e instanceof CQUAPIError) {
      if (e.statusCode === 401) {
        return c.json({ detail: "CQU token expired, please re-login" }, 401);
      }
      return c.json({ detail: e.message }, 502);
    }
    throw e;
  }
});

// GET /api/v1/departments
app.get("/departments", requireAuthWithCquToken, rateLimit("EXPLORE_LIMITER"), async (c) => {
  const user = c.get("user");
  const accessToken = await decrypt(user.accessToken!, c.env.ENCRYPTION_KEY);
  const api = new CQUAPIClient(accessToken);

  try {
    const departments = await api.getDepartments();
    return c.json({ departments });
  } catch (e) {
    if (e instanceof CQUAPIError) {
      return c.json({ detail: e.message }, 502);
    }
    throw e;
  }
});

export default app;
