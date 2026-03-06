import { describe, it, expect } from "vitest";
import configApp from "./config";

const mockEnv = {
  GIT_COMMIT: "abc123",
  GIT_DATE: "2026-03-01",
  PUBLIC_URL: "https://schedule.cqu.moe",
  HCAPTCHA_ENABLED: "false",
  HCAPTCHA_SITEKEY: "",
} as any;

function get(path: string, env = mockEnv) {
  return configApp.request(path, { method: "GET" }, env);
}

describe("GET /health", () => {
  it("returns status ok with commit info", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      commit: "abc123",
      date: "2026-03-01",
    });
  });
});

describe("GET /config", () => {
  it("returns merged config with captcha field and Cache-Control header", async () => {
    const res = await get("/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = await res.json();
    expect(body).toHaveProperty("public_url");
    expect(body).toHaveProperty("captcha");
    expect(body.captcha).toHaveProperty("enabled");
    expect(body.captcha).toHaveProperty("sitekey");
  });

  it("returns captcha disabled when HCAPTCHA_ENABLED is not 'true'", async () => {
    const res = await get("/config", { ...mockEnv, HCAPTCHA_ENABLED: "false" });
    const body = await res.json();
    expect(body.captcha.enabled).toBe(false);
    expect(body.captcha.sitekey).toBe("");
  });

  it("returns captcha enabled with sitekey when HCAPTCHA_ENABLED is 'true'", async () => {
    const res = await get("/config", {
      ...mockEnv,
      HCAPTCHA_ENABLED: "true",
      HCAPTCHA_SITEKEY: "site-key-123",
    });
    const body = await res.json();
    expect(body.captcha.enabled).toBe(true);
    expect(body.captcha.sitekey).toBe("site-key-123");
  });
});

describe("GET /captcha/config", () => {
  it("returns old format for compatibility", async () => {
    const res = await get("/captcha/config", {
      ...mockEnv,
      HCAPTCHA_ENABLED: "true",
      HCAPTCHA_SITEKEY: "site-key-456",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      sitekey: "site-key-456",
    });
  });

  it("returns disabled when HCAPTCHA_ENABLED is not 'true'", async () => {
    const res = await get("/captcha/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: false,
      sitekey: "",
    });
  });
});
