import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { handleCquApiError, errorResponse } from "./error";
import { CQUAPIError } from "../services/cqu-api";

describe("errorResponse", () => {
  it("returns structured error JSON", async () => {
    const res = errorResponse("BAD_REQUEST", "Invalid input", 400);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: { error: { code: "BAD_REQUEST", message: "Invalid input" } },
    });
  });
});

describe("handleCquApiError", () => {
  it("returns 401 TOKEN_EXPIRED for CQUAPIError with statusCode 401", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new CQUAPIError("expired", 401), "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: { error: { code: "TOKEN_EXPIRED", message: "CQU token expired, please re-login" } },
    });
  });

  it("returns 502 UPSTREAM_ERROR for CQUAPIError with non-401 status", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new CQUAPIError("Server error", 500), "Fallback"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      detail: { error: { code: "UPSTREAM_ERROR", message: "Server error" } },
    });
  });

  it("returns 502 UPSTREAM_ERROR with fallback for non-CQUAPIError", async () => {
    const app = new Hono();
    app.get("/test", (c) => handleCquApiError(c, new Error("random"), "Fallback message"));
    const res = await app.request("/test");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      detail: { error: { code: "UPSTREAM_ERROR", message: "Fallback message" } },
    });
  });
});
