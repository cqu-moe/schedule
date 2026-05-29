import { describe, it, expect } from "vitest";
import { resolveOrigin } from "./oauth-constants";

describe("resolveOrigin", () => {
  it("maps prod host", () => {
    expect(resolveOrigin("https://schedule.cqu.moe/api/v1/auth/oauth/login")).toBe("https://schedule.cqu.moe");
  });
  it("maps beta host", () => {
    expect(resolveOrigin("https://schedule-beta.cqu.moe/x")).toBe("https://schedule-beta.cqu.moe");
  });
  it("maps localhost to http", () => {
    expect(resolveOrigin("http://localhost:8787/x")).toBe("http://localhost:8787");
  });
  it("rejects unknown host (no substring match)", () => {
    expect(resolveOrigin("https://evil-schedule.cqu.moe.attacker.com/x")).toBeNull();
  });
});
