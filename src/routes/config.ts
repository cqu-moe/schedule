import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  const body: Record<string, string> = { status: "ok" };
  // Issue #100: build identifiers are internal-only; hide them in production.
  if (c.env.ENVIRONMENT !== "production") {
    body.commit = c.env.GIT_COMMIT ?? "dev";
    body.date = c.env.GIT_DATE ?? "unknown";
  }
  return c.json(body);
});

app.get("/config", (c) => {
  const response = c.json({
    public_url: c.env.PUBLIC_URL?.replace(/\/$/, "") ?? "",
  });
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
});

export default app;
