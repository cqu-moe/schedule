import { describe, it, expect, vi } from "vitest";
import oauthApp from "./oauth";
import { openTx } from "../services/oauth-tx";
import { AUTH_BASE, OAUTH_SCOPE } from "../services/oauth-constants";

// 32-byte (256-bit) key, base64-encoded — matches AES-GCM key length used by crypto.ts
const OAUTH_STATE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const mockEnv = {
  OAUTH_STATE_KEY,
  AUTH_OAUTH_CLIENT_ID: "test-client-id",
  UNAUTH_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
} as any;

// The sub-app serves "/login"; mounting at /api/v1/auth/oauth happens in the parent app.
// We request the sub-app's own path but vary the host (origin is resolved from the host).
function login(host: string, env = mockEnv) {
  return oauthApp.request(`${host}/login`, { method: "GET" }, env);
}

/** Pull the oauth_tx cookie value out of a Set-Cookie header. */
function cookieValue(setCookie: string): string {
  const match = /oauth_tx=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`no oauth_tx in Set-Cookie: ${setCookie}`);
  return decodeURIComponent(match[1]);
}

describe("GET /login", () => {
  it("redirects to the authorize endpoint with PKCE + state for the prod host", async () => {
    const res = await login("https://schedule.cqu.moe");

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toBeTruthy();
    expect(location.startsWith(`${AUTH_BASE}/api/auth/oauth2/authorize`)).toBe(true);

    const url = new URL(location);
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://schedule.cqu.moe/api/v1/auth/oauth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    // redirect_uri must be URL-encoded in the raw Location string
    expect(location).toContain(
      "redirect_uri=https%3A%2F%2Fschedule.cqu.moe%2Fapi%2Fv1%2Fauth%2Foauth%2Fcallback",
    );
    // scope spaces must be encoded (URLSearchParams uses '+')
    expect(location).toContain("scope=openid+offline_access+cqu%3Aticket%3Ajwxt");
  });

  it("sets a hardened oauth_tx cookie with Secure on https", async () => {
    const res = await login("https://schedule.cqu.moe");
    const setCookie = res.headers.get("Set-Cookie")!;

    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("oauth_tx=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/v1/auth/oauth");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("Secure");
  });

  it("uses the beta origin for redirect_uri and sealed cookie on the beta host", async () => {
    const res = await login("https://schedule-beta.cqu.moe");

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(
      "https://schedule-beta.cqu.moe/api/v1/auth/oauth/callback",
    );

    const sealed = cookieValue(res.headers.get("Set-Cookie")!);
    const tx = await openTx(sealed, OAUTH_STATE_KEY, Date.now());
    expect(tx).not.toBeNull();
    expect(tx!.origin).toBe("https://schedule-beta.cqu.moe");
  });

  it("omits Secure on the http localhost dev origin", async () => {
    const res = await login("http://localhost:8787");

    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("oauth_tx=");
    expect(setCookie).not.toContain("Secure");
  });

  it("returns 400 (no cookie, no redirect) for an unknown host", async () => {
    const res = await login("https://evil.example.com");

    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Location")).toBeNull();
    const body = await res.json();
    expect(body.detail.error.code).toBe("BAD_REQUEST");
  });

  it("round-trips state/origin through the sealed cookie and matches the Location state", async () => {
    const res = await login("https://schedule.cqu.moe");

    const locationState = new URL(res.headers.get("Location")!).searchParams.get("state");
    const sealed = cookieValue(res.headers.get("Set-Cookie")!);
    const tx = await openTx(sealed, OAUTH_STATE_KEY, Date.now());

    expect(tx).not.toBeNull();
    expect(tx!.origin).toBe("https://schedule.cqu.moe");
    expect(tx!.state).toBe(locationState);
    expect(tx!.verifier).toBeTruthy();
  });
});
