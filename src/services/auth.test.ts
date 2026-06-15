import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exchangeTicketForCquToken, AuthError } from "./auth";

// ── exchangeTicketForCquToken flow mock helper ──────────────────
//
// The exchange runs 3 fetches:
//   1. CAS validation:  GET CAS_SERVICE_URL?ticket=...  → Set-Cookie: SESSION
//   2. OAuth authorize: GET .../oauth/authorize         → Location: ...?code=...
//   3. Token exchange:  POST .../oauth/token            → { access_token, ... }

function createExchangeFetchMock(overrides: {
  casStatus?: number;
  casCookie?: string;
  authorizeStatus?: number;
  authorizeLocation?: string;
  tokenStatus?: number;
  tokenBody?: object;
} = {}) {
  const {
    casStatus = 302,
    casCookie = "SESSION=test-session; Path=/",
    authorizeStatus = 302,
    authorizeLocation =
      "https://my.cqu.edu.cn/workspace/token-index?code=test-code&state=",
    tokenStatus = 200,
    tokenBody = {
      access_token: "test-access",
      refresh_token: "test-refresh",
      expires_in: 14400,
    },
  } = overrides;

  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    callIndex++;
    switch (callIndex) {
      // Step 1: CAS ticket validation → SESSION cookie
      case 1:
        return Promise.resolve(
          new Response(null, {
            status: casStatus,
            headers: { "Set-Cookie": casCookie, Location: "/workspace/cas" },
          }),
        );
      // Step 2: OAuth authorize → authorization code
      case 2:
        return Promise.resolve(
          new Response(null, {
            status: authorizeStatus,
            headers: { Location: authorizeLocation },
          }),
        );
      // Step 3: token exchange
      case 3:
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

describe("exchangeTicketForCquToken", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a TokenResult on the full ticket → SESSION → OAuth → token chain", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    globalThis.fetch = createExchangeFetchMock();

    const result = await exchangeTicketForCquToken("ST-test123");

    expect(result.accessToken).toBe("test-access");
    expect(result.refreshToken).toBe("test-refresh");
    expect(result.expiresAt).toBe(new Date(now + 14400 * 1000).toISOString());
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("URL-encodes the ticket in the CAS validation request", async () => {
    globalThis.fetch = createExchangeFetchMock();

    await exchangeTicketForCquToken("ST-special+chars");

    const casCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const casUrl = casCall[0] as string;
    expect(casUrl).toContain("ticket=ST-special%2Bchars");
  });

  it("throws UPSTREAM_UNREACHABLE when SESSION cookie is missing", async () => {
    globalThis.fetch = createExchangeFetchMock({ casCookie: "" });

    try {
      await exchangeTicketForCquToken("ST-test123");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No SESSION cookie");
    }
  });

  it("throws UPSTREAM_UNREACHABLE when authorization code is missing", async () => {
    globalThis.fetch = createExchangeFetchMock({
      authorizeLocation: "https://my.cqu.edu.cn/workspace/token-index?state=",
    });

    try {
      await exchangeTicketForCquToken("ST-test123");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No authorization code");
    }
  });

  it("parses error_description on token exchange failure", async () => {
    globalThis.fetch = createExchangeFetchMock({
      tokenStatus: 400,
      tokenBody: {
        error: "invalid_grant",
        error_description: "Authorization code expired",
      },
    });

    try {
      await exchangeTicketForCquToken("ST-test123");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("Authorization code expired");
    }
  });

  it("throws UPSTREAM_UNREACHABLE when access_token is missing from token response", async () => {
    globalThis.fetch = createExchangeFetchMock({
      tokenBody: { token_type: "bearer" },
    });

    try {
      await exchangeTicketForCquToken("ST-test123");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
      expect(e.message).toContain("No access_token");
    }
  });

  it("defaults refreshToken to empty string when omitted", async () => {
    globalThis.fetch = createExchangeFetchMock({
      tokenBody: { access_token: "only-access", expires_in: 14400 },
    });

    const result = await exchangeTicketForCquToken("ST-test123");
    expect(result.accessToken).toBe("only-access");
    expect(result.refreshToken).toBe("");
  });

  it("throws UPSTREAM_UNREACHABLE on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    try {
      await exchangeTicketForCquToken("ST-test123");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_UNREACHABLE");
    }
  });

  it("throws UPSTREAM_TIMEOUT on AbortError", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

    try {
      await exchangeTicketForCquToken("ST-test123");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e.code).toBe("UPSTREAM_TIMEOUT");
    }
  });
});
