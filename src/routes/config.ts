import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    commit: c.env.GIT_COMMIT ?? "dev",
    date: c.env.GIT_DATE ?? "unknown",
  });
});

app.get("/config", (c) => {
  const response = c.json({
    public_url: c.env.PUBLIC_URL?.replace(/\/$/, "") ?? "",
  });
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
});

export default app;
