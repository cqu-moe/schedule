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
  const captchaEnabled = c.env.HCAPTCHA_ENABLED === "true";
  const response = c.json({
    public_url: c.env.PUBLIC_URL?.replace(/\/$/, "") ?? "",
    captcha: {
      enabled: captchaEnabled,
      sitekey: captchaEnabled ? (c.env.HCAPTCHA_SITEKEY ?? "") : "",
    },
  });
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
});

// Compatibility: redirect old captcha config endpoint (removed in #66)
app.get("/captcha/config", (c) => {
  const captchaEnabled = c.env.HCAPTCHA_ENABLED === "true";
  return c.json({
    enabled: captchaEnabled,
    sitekey: captchaEnabled ? (c.env.HCAPTCHA_SITEKEY ?? "") : "",
  });
});

export default app;
