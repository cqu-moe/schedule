import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock captcha service — must be before importing the app
vi.mock("../services/captcha", () => ({
  verifyCaptcha: vi.fn().mockResolvedValue(undefined),
  CaptchaError: class CaptchaError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CaptchaError";
    }
  },
}));

// Mock auth service — login won't be reached for validation failures
vi.mock("../services/auth", () => ({
  login: vi.fn(),
  AuthError: class AuthError extends Error {
    code = "";
  },
}));

import usersApp from "./users";

const mockEnv = {
  UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  HCAPTCHA_SECRET: "test-secret",
  HCAPTCHA_ENABLED: "false",
} as any;

function post(path: string, body: Record<string, unknown>) {
  return usersApp.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    mockEnv,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.UNAUTH_LIMITER.limit.mockResolvedValue({ success: true });
});

// ── Shared validation test suite for a given endpoint ────────────────
function describeValidation(endpointName: string, path: string) {
  describe(`${endpointName} input validation`, () => {
    // ── Missing fields ──────────────────────────────────────────────
    it("rejects missing student_id", async () => {
      const res = await post(path, { password: "test123" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.detail.error.message).toContain("student_id");
    });

    it("rejects missing password", async () => {
      const res = await post(path, { student_id: "20210001" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.detail.error.message).toContain("password");
    });

    it("rejects empty body", async () => {
      const res = await post(path, {});
      expect(res.status).toBe(400);
    });

    // ── student_id format ───────────────────────────────────────────
    it("rejects student_id with letters", async () => {
      const res = await post(path, { student_id: "abcdefgh", password: "test123" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.detail.error.message).toContain("student_id");
    });

    it("rejects student_id that is too short (7 digits)", async () => {
      const res = await post(path, { student_id: "2021001", password: "test123" });
      expect(res.status).toBe(400);
    });

    it("rejects student_id that is too long (9 digits)", async () => {
      const res = await post(path, { student_id: "202100012", password: "test123" });
      expect(res.status).toBe(400);
    });

    it("rejects 18-digit ID card with invalid check character", async () => {
      // 18-digit but ending with a letter other than X
      const res = await post(path, {
        student_id: "12345678901234567A",
        password: "test123",
      });
      expect(res.status).toBe(400);
    });

    it("rejects student_id with 10 digits (neither 8 nor 18)", async () => {
      const res = await post(path, { student_id: "1234567890", password: "test123" });
      expect(res.status).toBe(400);
    });

    it("accepts valid 8-digit student_id (does not return 400)", async () => {
      const res = await post(path, { student_id: "20210001", password: "test123" });
      // Should pass validation — may fail later due to missing DB/auth mock, but NOT 400
      expect(res.status).not.toBe(400);
    });

    it("accepts valid 18-digit ID card ending with digit (does not return 400)", async () => {
      const res = await post(path, {
        student_id: "123456789012345678",
        password: "test123",
      });
      expect(res.status).not.toBe(400);
    });

    it("accepts valid 18-digit ID card ending with X (does not return 400)", async () => {
      const res = await post(path, {
        student_id: "12345678901234567X",
        password: "test123",
      });
      expect(res.status).not.toBe(400);
    });

    // ── password length ─────────────────────────────────────────────
    it("rejects password exceeding 256 characters", async () => {
      const res = await post(path, {
        student_id: "20210001",
        password: "a".repeat(257),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.detail.error.message).toContain("256");
    });

    it("accepts password of exactly 256 characters (does not return 400)", async () => {
      const res = await post(path, {
        student_id: "20210001",
        password: "a".repeat(256),
      });
      expect(res.status).not.toBe(400);
    });
  });
}

// ── Run validation tests for all 3 unauthenticated POST endpoints ───
describeValidation("POST /api/v1/users (register)", "/");
describeValidation("POST /api/v1/users/recover", "/recover");
describeValidation("POST /api/v1/users/recover/verify", "/recover/verify");

// ── Edge cases ──────────────────────────────────────────────────────
describe("validation edge cases", () => {
  it("rejects invalid JSON body", async () => {
    const res = await usersApp.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail.error.message).toContain("JSON");
  });

  it("rejects student_id with lowercase x (only uppercase X allowed)", async () => {
    const res = await post("/", {
      student_id: "12345678901234567x",
      password: "test123",
    });
    expect(res.status).toBe(400);
  });
});
