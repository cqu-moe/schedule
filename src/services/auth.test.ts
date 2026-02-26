import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// ── Login flow mock helpers ─────────────────────────────────────

const SAMPLE_LOGIN_HTML = `
<html>
  <input type="hidden" id="login-page-flowkey" value="e1s1" />
  <span id="login-croypto">${Buffer.from("0123456789abcdef").toString("base64")}</span>
</html>
`;

const SAMPLE_ERROR_HTML = `
<html><span id="login-error-msg">用户名或密码错误</span></html>
`;

function createLoginFetchMock(overrides: {
  loginPageHtml?: string;
  loginPageCookie?: string;
  loginStatus?: number;
  loginLocation?: string;
  loginBody?: string;
  loginCookie?: string;
  casStatus?: number;
  casCookie?: string;
  authorizeStatus?: number;
  authorizeLocation?: string;
  tokenStatus?: number;
  tokenBody?: object;
} = {}) {
  const {
    loginPageHtml = SAMPLE_LOGIN_HTML,
    loginPageCookie = "JSESSIONID=abc123; Path=/",
    loginStatus = 302,
    loginLocation = "https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-test123",
    loginBody = "",
    loginCookie = "CASTGC=TGC-test456; Path=/; HttpOnly",
    casStatus = 302,
    casCookie = "SESSION=test-session; Path=/",
    authorizeStatus = 302,
    authorizeLocation = "https://my.cqu.edu.cn/workspace/token-index?code=test-code&state=",
    tokenStatus = 200,
    tokenBody = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 14400 },
  } = overrides;

  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    callIndex++;
    switch (callIndex) {
      case 1:
        return Promise.resolve(new Response(loginPageHtml, {
          status: 200,
          headers: { "Set-Cookie": loginPageCookie },
        }));
      case 2: {
        const headers: Record<string, string> = {};
        if (loginStatus === 302) {
          headers["Location"] = loginLocation;
          headers["Set-Cookie"] = loginCookie;
        } else {
          headers["Content-Type"] = "text/html";
        }
        return Promise.resolve(new Response(loginBody, { status: loginStatus, headers }));
      }
      case 3:
        return Promise.resolve(
          new Response(null, {
            status: casStatus,
            headers: { "Set-Cookie": casCookie, Location: "/workspace/cas" },
          }),
        );
      case 4:
        return Promise.resolve(
          new Response(null, {
            status: authorizeStatus,
            headers: { Location: authorizeLocation },
          }),
        );
      case 5:
        return Promise.resolve(
          new Response(JSON.stringify(tokenBody), {
            status: tokenStatus,
            headers: { "Content-Type": "application/json" },
          }),
        );
      default:
        return Promise.reject(new Error(`Unexpected fetch call #${callIndex}`));
    }
  });
}

// ── login tests ─────────────────────────────────────────────────

describe("login", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return TokenResult on successful 5-step login", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    globalThis.fetch = createLoginFetchMock();

    const result = await login("user1", "pass1");

    expect(result.accessToken).toBe("test-access");
    expect(result.refreshToken).toBe("test-refresh");
    expect(result.expiresAt).toBe(new Date(now + 14400 * 1000).toISOString());
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
  });

  it("should throw INVALID_CREDENTIALS on 401", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginStatus: 401,
      loginBody: SAMPLE_ERROR_HTML,
    });

    try {
      await login("bad-user", "bad-pass");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("INVALID_CREDENTIALS");
      expect(e.message).toContain("用户名或密码错误");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE when login page is unparseable", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginPageHtml: "<html>broken page</html>",
    });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE when no ticket in redirect", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginLocation: "https://my.cqu.edu.cn/authserver/authentication/cas",
    });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No ticket");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
    }
  });

  it("should forward login page cookies to Step 2", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginPageCookie: "JSESSIONID=sess-abc; Path=/",
    });

    await login("user1", "pass1");

    const step2Call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const step2Init = step2Call[1] as RequestInit;
    expect((step2Init.headers as Record<string, string>)["Cookie"]).toContain("JSESSIONID=sess-abc");
  });

  it("should forward CASTGC cookie to Step 3", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginCookie: "CASTGC=TGC-xyz789; Path=/; HttpOnly",
    });

    await login("user1", "pass1");

    const step3Call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2];
    const step3Init = step3Call[1] as RequestInit;
    expect((step3Init.headers as Record<string, string>)["Cookie"]).toContain("CASTGC=TGC-xyz789");
  });

  it("should URL-encode ticket in Step 3", async () => {
    globalThis.fetch = createLoginFetchMock({
      loginLocation: "https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-special%2Bchars",
    });

    await login("user1", "pass1");

    const step3Call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2];
    const step3Url = step3Call[0] as string;
    expect(step3Url).toContain("ticket=ST-special%252Bchars");
  });

  it("should throw CAPTCHA_REQUIRED when captchaId is present", async () => {
    const htmlWithCaptcha = `
      <html>
        <input type="hidden" id="login-page-flowkey" value="e1s1" />
        <span id="login-croypto">${Buffer.from("0123456789abcdef").toString("base64")}</span>
        <input id="captchaId" value="cap-abc" />
      </html>
    `;
    globalThis.fetch = createLoginFetchMock({ loginPageHtml: htmlWithCaptcha });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("CAPTCHA_REQUIRED");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE when SESSION cookie is missing", async () => {
    globalThis.fetch = createLoginFetchMock({ casCookie: "" });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No SESSION cookie");
    }
  });

  it("should throw UPSTREAM_UNREACHABLE when authorization code is missing", async () => {
    globalThis.fetch = createLoginFetchMock({
      authorizeLocation: "https://my.cqu.edu.cn/workspace/token-index?state=",
    });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No authorization code");
    }
  });

  it("should parse error_description on token exchange failure", async () => {
    globalThis.fetch = createLoginFetchMock({
      tokenStatus: 400,
      tokenBody: { error: "invalid_grant", error_description: "Authorization code expired" },
    });

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("Authorization code expired");
    }
  });

  it("should throw UPSTREAM_TIMEOUT on AbortError", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    try {
      await login("user1", "pass1");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_TIMEOUT");
    }
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
