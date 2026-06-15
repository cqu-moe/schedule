import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "./index";
import type {
  AuthService,
  CalendarCaps,
  VerifiedSession,
} from "./services/auth-rpc";

// ── caps preset ───────────────────────────────────────────────────────────────

const FULL_CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  sub_limit: 10,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

/** AUTH binding whose verifySession returns a fixed session. */
function fakeAuth(userId: string, caps: CalendarCaps): AuthService {
  const session: VerifiedSession = {
    user: { id: userId, name: "测试", email: `${userId}@cqu.moe`, role: "user" },
    caps: { calendar: caps },
  };
  return {
    async verifySession() {
      return session;
    },
    async getCquTicket() {
      return { error: "NOT_USED" };
    },
  };
}

/** AUTH binding whose verifySession always returns null (unauthenticated). */
function nullAuth(): AuthService {
  return {
    async verifySession() {
      return null;
    },
    async getCquTicket() {
      return { error: "NOT_USED" };
    },
  };
}

// Give each request a unique IP so any rate-limited route never trips a shared
// bucket. The /me, /health and /v1 routes are not rate-limited, but be safe.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 254}.${ipCounter}`;
}

/**
 * Issue a request against the top-level app with an explicit AUTH binding so the
 * dev-mock injection (`!c.env.AUTH`) never kicks in.
 */
function request(path: string, auth: AuthService, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", uniqueIp());
  const testEnv = { ...env, AUTH: auth };
  return app.request(path, { ...init, headers }, testEnv);
}

describe("v1 → 410 catch-all", () => {
  it("GET /api/v1/anything → 410 GONE", async () => {
    const res = await request("/api/v1/anything", fakeAuth("userA", FULL_CAPS));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("GONE");
  });
});

describe("GET /api/v2/me", () => {
  it("with a valid session → 200 { user, caps }", async () => {
    const res = await request("/api/v2/me", fakeAuth("userA", FULL_CAPS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; name: string; email: string; role: string };
      caps: { calendar: CalendarCaps };
    };
    expect(body.user).toEqual({
      id: "userA",
      name: "测试",
      email: "userA@cqu.moe",
      role: "user",
    });
    expect(body.caps).toEqual({ calendar: FULL_CAPS });
  });

  it("with no session (verifySession → null) → 401 UNAUTHORIZED", async () => {
    const res = await request("/api/v2/me", nullAuth());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /api/v2/health", () => {
  it("→ 200 (config now mounted under /api/v2)", async () => {
    const res = await request("/api/v2/health", fakeAuth("userA", FULL_CAPS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("AUTH binding fail-closed (security)", () => {
  /** Clone the test env with the AUTH binding removed. */
  function envWithoutAuth() {
    const clone = { ...env } as Record<string, unknown>;
    delete clone.AUTH;
    return clone as unknown as typeof env;
  }

  it("missing AUTH on a production host → 500, NOT a fail-open mock session", async () => {
    const headers = new Headers({ "CF-Connecting-IP": uniqueIp() });
    const res = await app.request(
      "https://schedule.cqu.moe/api/v2/me",
      { headers },
      envWithoutAuth(),
    );
    // Must fail closed: a misconfigured deployment must never silently
    // authenticate every request as the fixed dev user.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INTERNAL_ERROR");
  });

  it("missing AUTH on localhost → dev mock injected (200)", async () => {
    const headers = new Headers({ "CF-Connecting-IP": uniqueIp() });
    const res = await app.request(
      "http://localhost/api/v2/me",
      { headers },
      envWithoutAuth(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe("devuser000000000000000000000000");
  });
});

describe("CORS preflight", () => {
  it("OPTIONS to a link path with PATCH method → allows PATCH", async () => {
    const res = await request("/api/v2/subscriptions/x/links/y", fakeAuth("userA", FULL_CAPS), {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "PATCH",
      },
    });
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowMethods).toContain("PATCH");
  });
});
