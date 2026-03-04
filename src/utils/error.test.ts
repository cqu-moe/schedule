import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { handleCquApiError } from "./error";
import { CQUAPIError } from "../services/cqu-api";

describe("handleCquApiError", () => {
  it("returns 401 for CQUAPIError with statusCode 401", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new CQUAPIError("expired", 401), "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "CQU token expired, please re-login" });
  });

  it("returns 502 for CQUAPIError with non-401 status", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new CQUAPIError("Server error", 500), "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ detail: "Server error" });
  });

  it("returns 502 with fallback for non-CQUAPIError", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new Error("random"), "Fallback message"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ detail: "Fallback message" });
  });
});
