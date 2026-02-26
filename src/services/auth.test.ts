import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock @cloudflare/playwright ─────────────────────────────────
// vi.hoisted returns values that are available inside the hoisted vi.mock factory.
const { mockLaunch, mockNewPage, mockClose } = vi.hoisted(() => {
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockNewPage = vi.fn();
  const mockLaunch = vi.fn();
  return { mockLaunch, mockNewPage, mockClose };
});

vi.mock("@cloudflare/playwright", () => ({
  launch: mockLaunch,
}));

import { refreshToken, login, AuthError, encryptAesEcb, parseLoginPage } from "./auth";

// ── Helpers ─────────────────────────────────────────────────────

/** Build a fresh mock Response for each fetch call. */
function createFetchMock(
  body: unknown,
  status = 200,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** Create a mock Playwright Page with configurable behavior. */
function createMockPage(overrides: {
  evaluateResults?: Map<string, string | null>;
  raceResult?: "success" | "error" | "timeout";
  errorText?: string | null;
  url?: string;
} = {}) {
  const {
    evaluateResults = new Map<string, string | null>(),
    raceResult = "success",
    errorText = null,
    url = "https://self.cqu.edu.cn/cas-success",
  } = overrides;

  const mockLocatorObj = {
    first: vi.fn().mockReturnThis(),
    waitFor: vi.fn<any>().mockImplementation(() => {
      if (raceResult === "error") return Promise.resolve();
      // For "success" and "timeout" the error locator should never resolve
      return new Promise(() => {});
    }),
    isVisible: vi.fn().mockResolvedValue(raceResult === "error"),
    textContent: vi.fn().mockResolvedValue(errorText),
  };

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn<any>().mockImplementation(() => {
      if (raceResult === "success") return Promise.resolve();
      // "error" and "timeout" — URL wait should never resolve
      return new Promise(() => {});
    }),
    locator: vi.fn().mockReturnValue(mockLocatorObj),
    evaluate: vi.fn<any>().mockImplementation((...args: any[]) => {
      const key = args[1] as string;
      return Promise.resolve(evaluateResults.get(key) ?? null);
    }),
    url: vi.fn().mockReturnValue(url),
  };

  return page;
}

// ── refreshToken tests ──────────────────────────────────────────

describe("refreshToken", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return correct TokenResult on successful refresh", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    globalThis.fetch = createFetchMock({
      access_token: "new-access-tok",
      refresh_token: "new-refresh-tok",
      expires_in: 7200,
    });

    const result = await refreshToken("old-refresh-tok");

    expect(result.accessToken).toBe("new-access-tok");
    expect(result.refreshToken).toBe("new-refresh-tok");
    const expectedExpiry = new Date(now + 7200 * 1000).toISOString();
    expect(result.expiresAt).toBe(expectedExpiry);
  });

  it("should throw AuthError TOKEN_EXPIRED on HTTP 401", async () => {
    globalThis.fetch = createFetchMock(
      { error: "unauthorized", error_description: "Token has been revoked" },
      401,
    );

    try {
      await refreshToken("bad-tok");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("TOKEN_EXPIRED");
      expect(e.message).toContain("Token has been revoked");
    }
  });

  it("should throw AuthError TOKEN_EXPIRED on HTTP 400 with invalid_grant", async () => {
    globalThis.fetch = createFetchMock(
      { error: "invalid_grant", error_description: "Grant expired" },
      400,
    );

    try {
      await refreshToken("expired-tok");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("TOKEN_EXPIRED");
    }
  });

  it("should throw AuthError UPSTREAM_UNREACHABLE on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    try {
      await refreshToken("some-tok");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("Network error");
    }
  });

  it("should throw AuthError UPSTREAM_UNREACHABLE when access_token is missing", async () => {
    globalThis.fetch = createFetchMock({ token_type: "bearer" });

    try {
      await refreshToken("some-tok");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No access_token");
    }
  });
});

// ── login tests ─────────────────────────────────────────────────

describe("login", () => {
  const fakeBrowser = {} as any;

  beforeEach(() => {
    // Reset mocks but re-establish the launch return structure
    mockClose.mockReset().mockResolvedValue(undefined);
    mockNewPage.mockReset();
    mockLaunch.mockReset().mockResolvedValue({
      newPage: mockNewPage,
      close: mockClose,
    });
  });

  it("should return correct TokenResult on successful login", async () => {
    const tokenMap = new Map<string, string | null>([
      ["cqu_edu_ACCESS_TOKEN", '"my-access-token"'],
      ["cqu_edu_REFRESH_TOKEN", '"my-refresh-token"'],
    ]);

    const page = createMockPage({
      raceResult: "success",
      evaluateResults: tokenMap,
    });
    mockNewPage.mockResolvedValue(page);

    const result = await login(fakeBrowser, "user1", "pass1");

    expect(result.accessToken).toBe("my-access-token");
    expect(result.refreshToken).toBe("my-refresh-token");
    expect(result.expiresAt).toBeTruthy();
    // Verify ISO format
    expect(new Date(result.expiresAt).toISOString()).toBe(result.expiresAt);

    // Verify login flow was executed
    expect(page.goto).toHaveBeenCalled();
    expect(page.fill).toHaveBeenCalledTimes(2);
    expect(page.click).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it("should throw AuthError INVALID_CREDENTIALS when error element is visible", async () => {
    const page = createMockPage({
      raceResult: "error",
      errorText: "Invalid username or password",
    });
    mockNewPage.mockResolvedValue(page);

    try {
      await login(fakeBrowser, "bad-user", "bad-pass");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("INVALID_CREDENTIALS");
      expect(e.message).toContain("Invalid username or password");
    }

    // Browser should still be closed
    expect(mockClose).toHaveBeenCalled();
  });

  it("should throw AuthError UPSTREAM_TIMEOUT when neither success nor error resolves", async () => {
    const page = createMockPage({
      raceResult: "success",
      url: "https://sso.cqu.edu.cn/login",
    });
    // Override: both waitForURL and locator.waitFor reject (simulating timeout)
    page.waitForURL.mockRejectedValue(new Error("Timeout exceeded"));
    const locatorObj = {
      first: vi.fn().mockReturnThis(),
      waitFor: vi.fn().mockRejectedValue(new Error("Timeout exceeded")),
      isVisible: vi.fn().mockResolvedValue(false),
      textContent: vi.fn().mockResolvedValue(null),
    };
    page.locator.mockReturnValue(locatorObj);
    mockNewPage.mockResolvedValue(page);

    try {
      await login(fakeBrowser, "user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_TIMEOUT");
    }

    expect(mockClose).toHaveBeenCalled();
  });

  it("should throw AuthError BROWSER_ERROR when token is not found after retries", async () => {
    const page = createMockPage({
      raceResult: "success",
      evaluateResults: new Map(), // empty = all null
    });
    mockNewPage.mockResolvedValue(page);

    try {
      await login(fakeBrowser, "user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("BROWSER_ERROR");
      expect(e.message).toContain("Unable to retrieve access token");
    }

    // Should have tried the fallback URL as well
    const gotoArgs = page.goto.mock.calls.map((c: any[]) => c[0]);
    expect(gotoArgs).toContain("https://my.cqu.edu.cn/enroll");

    expect(mockClose).toHaveBeenCalled();
  });
});

// ── encryptAesEcb tests ─────────────────────────────────────────

describe("encryptAesEcb", () => {
  it("should encrypt plaintext with AES-128-ECB and return base64", () => {
    const keyBase64 = Buffer.from("0123456789abcdef").toString("base64");
    const result = encryptAesEcb("hello", keyBase64);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(() => Buffer.from(result, "base64")).not.toThrow();
  });

  it("should produce consistent output for same input", () => {
    const keyBase64 = Buffer.from("0123456789abcdef").toString("base64");
    const r1 = encryptAesEcb("test", keyBase64);
    const r2 = encryptAesEcb("test", keyBase64);
    expect(r1).toBe(r2);
  });

  it("should produce different output for different keys", () => {
    const key1 = Buffer.from("0123456789abcdef").toString("base64");
    const key2 = Buffer.from("fedcba9876543210").toString("base64");
    expect(encryptAesEcb("test", key1)).not.toBe(encryptAesEcb("test", key2));
  });
});

// ── parseLoginPage tests ────────────────────────────────────────

describe("parseLoginPage", () => {
  const sampleHtml = `
    <html>
      <input type="hidden" id="login-page-flowkey" value="e1s1" />
      <span id="login-croypto">d9XYfl9siLfxBU+Ze1LxSQ==</span>
      <input id="captchaId" value="cap-123" />
    </html>
  `;

  it("should extract execution, croypto, and captchaId", () => {
    const result = parseLoginPage(sampleHtml);
    expect(result.execution).toBe("e1s1");
    expect(result.croypto).toBe("d9XYfl9siLfxBU+Ze1LxSQ==");
    expect(result.captchaId).toBe("cap-123");
  });

  it("should return null captchaId when not present", () => {
    const html = `
      <html>
        <input type="hidden" id="login-page-flowkey" value="e1s1" />
        <span id="login-croypto">key123==</span>
      </html>
    `;
    const result = parseLoginPage(html);
    expect(result.execution).toBe("e1s1");
    expect(result.croypto).toBe("key123==");
    expect(result.captchaId).toBeNull();
  });

  it("should throw AuthError when execution is missing", () => {
    const html = `<html><span id="login-croypto">key==</span></html>`;
    expect(() => parseLoginPage(html)).toThrow(AuthError);
  });

  it("should throw AuthError when croypto is missing", () => {
    const html = `<html><input id="login-page-flowkey" value="e1s1" /></html>`;
    expect(() => parseLoginPage(html)).toThrow(AuthError);
  });
});
