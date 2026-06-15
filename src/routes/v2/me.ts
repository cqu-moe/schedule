import { Hono } from "hono";
import type { SessionEnv } from "../../middleware/session";

const app = new Hono<SessionEnv>();

// GET /api/v2/me — current session's user + caps (mounted under sessionMiddleware).
// `caps` is returned as the full { calendar: {...} } object, not flattened.
app.get("/", (c) => c.json({ user: c.get("user"), caps: c.get("caps") }));

export default app;
