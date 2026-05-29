import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  exchangeCode,
  refreshAuthToken,
  getUserInfo,
  getCquStatus,
  getServiceTicket,
  AuthOAuthError,
} from "./auth-oauth-client";
import type { Env } from "../types";

// ── Helpers ─────────────────────────────────────────────────────

/** Build a one-shot mock fetch returning the given JSON body + status. */
function jsonFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** Minimal fake env carrying just the OAuth client credentials. */
const fakeEnv = {
  AUTH_OAUTH_CLIENT_ID: "test-client",
  AUTH_OAUTH_CLIENT_SECRET: "test-secret",
} as unknown as Env;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── exchangeCode ────────────────────────────────────────────────

describe("exchangeCode", () => {
  it("returns token set on success", async () => {
    globalThis.fetch = jsonFetch({
      access_token: "acc-tok",
      refresh_token: "ref-tok",
      id_token: "id-tok",
      expires_in: 3600,
      scope: "openid offline_access cqu:ticket:jwxt",
    });

    const result = await exchangeCode(fakeEnv, {
      code: "the-code",
      redirectUri: "https://schedule.cqu.moe/api/v1/auth/oauth/callback",
      codeVerifier: "the-verifier",
    });

    expect(result.accessToken).toBe("acc-tok");
    expect(result.refreshToken).toBe("ref-tok");
    expect(result.idToken).toBe("id-tok");
    expect(result.expiresIn).toBe(3600);
  });

  it("POSTs an authorization_code form body to the token endpoint", async () => {
    const mock = jsonFetch({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
    });
    globalThis.fetch = mock;

    await exchangeCode(fakeEnv, {
      code: "the-code",
      redirectUri: "https://app/cb",
      codeVerifier: "ver",
    });

    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe("https://auth.cqu.moe/api/auth/oauth2/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_id")).toBe("test-client");
    expect(body.get("client_secret")).toBe("test-secret");
    expect(body.get("redirect_uri")).toBe("https://app/cb");
    expect(body.get("code_verifier")).toBe("ver");
  });

  it("throws user-kind AuthOAuthError on HTTP 400 invalid_grant", async () => {
    globalThis.fetch = jsonFetch(
      { error: "invalid_grant", error_description: "code expired" },
      400,
    );

    try {
      await exchangeCode(fakeEnv, {
        code: "bad",
        redirectUri: "https://app/cb",
        codeVerifier: "ver",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).code).toBe("invalid_grant");
      expect((e as AuthOAuthError).kind).toBe("user");
    }
  });
});

// ── refreshAuthToken ────────────────────────────────────────────

describe("refreshAuthToken", () => {
  it("returns token set on success", async () => {
    globalThis.fetch = jsonFetch({
      access_token: "new-acc",
      refresh_token: "new-ref",
      expires_in: 3600,
    });

    const result = await refreshAuthToken(fakeEnv, "old-ref");
    expect(result.accessToken).toBe("new-acc");
    expect(result.refreshToken).toBe("new-ref");
    expect(result.expiresIn).toBe(3600);
  });

  it("returns empty refreshToken when rotation omits a new one", async () => {
    globalThis.fetch = jsonFetch({
      access_token: "new-acc",
      expires_in: 3600,
    });

    const result = await refreshAuthToken(fakeEnv, "old-ref");
    expect(result.accessToken).toBe("new-acc");
    expect(result.refreshToken).toBe("");
  });

  it("POSTs a refresh_token form body", async () => {
    const mock = jsonFetch({ access_token: "a", expires_in: 3600 });
    globalThis.fetch = mock;

    await refreshAuthToken(fakeEnv, "old-ref");

    const [, init] = mock.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-ref");
    expect(body.get("client_id")).toBe("test-client");
    expect(body.get("client_secret")).toBe("test-secret");
  });

  it("maps invalid_grant to user kind", async () => {
    globalThis.fetch = jsonFetch({ error: "invalid_grant" }, 400);
    try {
      await refreshAuthToken(fakeEnv, "revoked");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).kind).toBe("user");
    }
  });

  it("maps invalid_client to operator kind", async () => {
    globalThis.fetch = jsonFetch({ error: "invalid_client" }, 401);
    try {
      await refreshAuthToken(fakeEnv, "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as AuthOAuthError).kind).toBe("operator");
      expect((e as AuthOAuthError).code).toBe("invalid_client");
    }
  });

  it("maps invalid_scope to operator kind", async () => {
    globalThis.fetch = jsonFetch({ error: "invalid_scope" }, 400);
    try {
      await refreshAuthToken(fakeEnv, "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as AuthOAuthError).kind).toBe("operator");
    }
  });

  it("maps HTTP 503 to transient kind", async () => {
    globalThis.fetch = jsonFetch({ error: "server_error" }, 503);
    try {
      await refreshAuthToken(fakeEnv, "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });

  it("maps other 4xx to user kind (safe default: needs re-auth)", async () => {
    globalThis.fetch = jsonFetch({ error: "unauthorized_client" }, 400);
    try {
      await refreshAuthToken(fakeEnv, "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as AuthOAuthError).kind).toBe("user");
    }
  });

  it("maps network errors to transient kind", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Network failure"));
    try {
      await refreshAuthToken(fakeEnv, "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });

  it("maps AbortError (timeout) to transient kind", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    try {
      await refreshAuthToken(fakeEnv, "x");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).code).toBe("timeout");
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });
});

// ── getUserInfo ─────────────────────────────────────────────────

describe("getUserInfo", () => {
  it("returns { sub } on success", async () => {
    globalThis.fetch = jsonFetch({
      sub: "user-123",
      name: "张三",
      email: "z@example.com",
    });
    const result = await getUserInfo("acc-tok");
    expect(result.sub).toBe("user-123");
  });

  it("sends a Bearer Authorization header", async () => {
    const mock = jsonFetch({ sub: "user-123" });
    globalThis.fetch = mock;
    await getUserInfo("acc-tok");
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe(
      "https://auth.cqu.moe/api/auth/oauth2/userinfo",
    );
    expect(init.headers.Authorization).toBe("Bearer acc-tok");
  });

  it("throws transient AuthOAuthError when sub is absent", async () => {
    globalThis.fetch = jsonFetch({ name: "no-sub" });
    try {
      await getUserInfo("acc-tok");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });

  it("throws transient AuthOAuthError on non-OK response", async () => {
    globalThis.fetch = jsonFetch({ error: "boom" }, 500);
    try {
      await getUserInfo("acc-tok");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });
});

// ── getCquStatus ────────────────────────────────────────────────

describe("getCquStatus", () => {
  it("passes through status and studentId", async () => {
    globalThis.fetch = jsonFetch({
      status: "active",
      studentId: "20231234",
      lastKeepAlive: 123,
    });
    const result = await getCquStatus("acc-tok");
    expect(result.status).toBe("active");
    expect(result.studentId).toBe("20231234");
  });

  it("handles unbound status without studentId", async () => {
    globalThis.fetch = jsonFetch({ status: "unbound" });
    const result = await getCquStatus("acc-tok");
    expect(result.status).toBe("unbound");
    expect(result.studentId).toBeUndefined();
  });

  it("throws transient AuthOAuthError on non-OK response", async () => {
    globalThis.fetch = jsonFetch({ error: "boom" }, 500);
    try {
      await getCquStatus("acc-tok");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });
});

// ── getServiceTicket ────────────────────────────────────────────

describe("getServiceTicket", () => {
  it("returns the ticket string", async () => {
    globalThis.fetch = jsonFetch({ ticket: "ST-12345-ABCDEF" });
    const ticket = await getServiceTicket("acc-tok");
    expect(ticket).toBe("ST-12345-ABCDEF");
  });

  it("requests the jwxt service with a Bearer header", async () => {
    const mock = jsonFetch({ ticket: "ST-1" });
    globalThis.fetch = mock;
    await getServiceTicket("acc-tok");
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe(
      "https://auth.cqu.moe/api/cqu/service-ticket?service=jwxt",
    );
    expect(init.headers.Authorization).toBe("Bearer acc-tok");
  });

  it("throws operator-kind scope_forbidden on HTTP 403", async () => {
    globalThis.fetch = jsonFetch(
      { detail: { error: { code: "FORBIDDEN", message: "missing scope" } } },
      403,
    );
    try {
      await getServiceTicket("acc-tok");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).code).toBe("scope_forbidden");
      expect((e as AuthOAuthError).kind).toBe("operator");
    }
  });

  it("throws transient AuthOAuthError on other non-OK response", async () => {
    globalThis.fetch = jsonFetch({ error: "boom" }, 500);
    try {
      await getServiceTicket("acc-tok");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });

  it("throws transient AuthOAuthError when ticket is missing from body", async () => {
    globalThis.fetch = jsonFetch({ service: "jwxt" });
    try {
      await getServiceTicket("acc-tok");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthOAuthError);
      expect((e as AuthOAuthError).kind).toBe("transient");
    }
  });
});
