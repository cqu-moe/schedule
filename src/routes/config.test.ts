import { describe, it, expect } from "vitest";
import configApp from "./config";

const mockEnv = {
  GIT_COMMIT: "abc123",
  GIT_DATE: "2026-03-01",
  PUBLIC_URL: "https://schedule.cqu.moe",
} as any;

function get(path: string, env = mockEnv) {
  return configApp.request(path, { method: "GET" }, env);
}

describe("GET /health", () => {
  it.each(["development", "preview", undefined])(
    "non-production (%s) returns status ok with commit info",
    async (environment) => {
      const res = await get("/health", { ...mockEnv, ENVIRONMENT: environment });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        status: "ok",
        commit: "abc123",
        date: "2026-03-01",
      });
    },
  );

  it("production omits build identifiers (issue #100)", async () => {
    const res = await get("/health", { ...mockEnv, ENVIRONMENT: "production" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});

describe("GET /config", () => {
  it("returns public_url with Cache-Control header and no captcha field", async () => {
    const res = await get("/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.public_url).toBe("https://schedule.cqu.moe");
    expect(body).not.toHaveProperty("captcha");
  });

  it("trims a trailing slash from PUBLIC_URL", async () => {
    const res = await get("/config", { ...mockEnv, PUBLIC_URL: "https://schedule.cqu.moe/" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.public_url).toBe("https://schedule.cqu.moe");
  });
});


it("exposes only implemented and explicitly enabled external sources", async () => {
  const response = await get("/config", { ...mockEnv, EXTERNAL_SUBSCRIPTION_TYPES: "admin_class,instructor,room,student" });
  expect(await response.json()).toMatchObject({ external: { search_types: ["admin_class", "instructor", "room"], create_types: ["admin_class", "instructor", "room"] } });
  expect(await (await get("/config")).json()).toMatchObject({ external: { search_types: [], create_types: [] } });
});
