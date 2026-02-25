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
  return c.json({
    public_url: c.env.PUBLIC_URL?.replace(/\/$/, "") ?? "",
  });
});

app.get("/captcha/config", (c) => {
  const enabled = c.env.HCAPTCHA_ENABLED === "true";
  return c.json({
    enabled,
    sitekey: enabled ? (c.env.HCAPTCHA_SITEKEY ?? "") : "",
  });
});

export default app;
