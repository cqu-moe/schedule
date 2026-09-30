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
function fakeAuth(
  userId: string,
  caps: CalendarCaps,
  cquBindStatus?: VerifiedSession["cquBindStatus"],
): AuthService {
  const session: VerifiedSession = {
    user: { id: userId, name: "测试", email: `${userId}@cqu.moe`, role: "user" },
    caps: { calendar: caps },
    cquBindStatus,
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
function request(
  path: string,
  auth: AuthService,
  init: RequestInit = {},
  envOverrides: Partial<typeof env> = {},
) {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", uniqueIp());
  const testEnv = { ...env, AUTH: auth, ...envOverrides };
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

describe("PostHog cookie recovery", () => {
  it("clears the legacy cross-domain PostHog cookie", async () => {
    const testEnv = { ...env, AUTH: fakeAuth("userA", FULL_CAPS), POSTHOG_PROJECT_TOKEN: "test" };
    const res = await app.request("/api/v2/telemetry/reset", {}, testEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ph_test_posthog=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Domain=.cqu.moe");
  });

  it("rejects cross-origin requests without clearing the cookie (#96)", async () => {
    const res = await request(
      "/api/v2/telemetry/reset",
      fakeAuth("userA", FULL_CAPS),
      { headers: { Origin: "https://evil.example" } },
      { POSTHOG_PROJECT_TOKEN: "test" },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still resets for an allowed sibling origin", async () => {
    const res = await request(
      "/api/v2/telemetry/reset",
      fakeAuth("userA", FULL_CAPS),
      { headers: { Origin: "https://schedule.cqu.moe" } },
      { POSTHOG_PROJECT_TOKEN: "test" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
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

  it("passes through cquBindStatus when the auth RPC supplies it", async () => {
    const res = await request("/api/v2/me", fakeAuth("userA", FULL_CAPS, "active"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cquBindStatus?: string };
    expect(body.cquBindStatus).toBe("active");
  });

  it("omits cquBindStatus for older auth deploys that do not supply it", async () => {
    const res = await request("/api/v2/me", fakeAuth("userA", FULL_CAPS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("cquBindStatus" in body).toBe(false);
  });
});

describe("GET /api/v2/health", () => {
  it("→ 200 (config now mounted under /api/v2); production hides build identifiers (#100)", async () => {
    const res = await request("/api/v2/health", fakeAuth("userA", FULL_CAPS));
    expect(res.status).toBe(200);
    // Shared test env inherits ENVIRONMENT=production from wrangler.jsonc.
    const body = (await res.json()) as { status: string; commit?: string; date?: string };
    expect(body.status).toBe("ok");
    expect(body.commit).toBeUndefined();
    expect(body.date).toBeUndefined();
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

  it("missing AUTH on localhost without DEV_AUTH_MOCK → 500, NOT a fail-open mock session", async () => {
    const headers = new Headers({ "CF-Connecting-IP": uniqueIp() });
    const res = await app.request(
      "http://localhost/api/v2/me",
      { headers },
      envWithoutAuth(),
    );
    // Acceptance for #86: without the explicit env var, no hostname injects mock.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INTERNAL_ERROR");
  });

  it("missing AUTH on localhost with DEV_AUTH_MOCK=1 → dev mock injected (200)", async () => {
    const headers = new Headers({ "CF-Connecting-IP": uniqueIp() });
    const res = await app.request(
      "http://localhost/api/v2/me",
      { headers },
      { ...envWithoutAuth(), DEV_AUTH_MOCK: "1" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe("devuser000000000000000000000000");
  });
});

describe("AUTH_LIMITER on authenticated v2 routes", () => {
  /** A limiter binding that always reports the bucket as exhausted. */
  function rejectingLimiter() {
    return { limit: async () => ({ success: false }) };
  }

  it("rate-limits GET /api/v2/me when AUTH_LIMITER trips → 429", async () => {
    const testEnv = { ...env, AUTH: fakeAuth("userA", FULL_CAPS), AUTH_LIMITER: rejectingLimiter() };
    const res = await app.request(
      "/api/v2/me",
      { headers: { "CF-Connecting-IP": uniqueIp() } },
      testEnv,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("RATE_LIMITED");
  });

  it("rate-limits GET /api/v2/subscriptions when AUTH_LIMITER trips → 429", async () => {
    const testEnv = { ...env, AUTH: fakeAuth("userA", FULL_CAPS), AUTH_LIMITER: rejectingLimiter() };
    const res = await app.request(
      "/api/v2/subscriptions",
      { headers: { "CF-Connecting-IP": uniqueIp() } },
      testEnv,
    );
    expect(res.status).toBe(429);
  });

  it("allows the request through when AUTH_LIMITER has capacity", async () => {
    const passingLimiter = { limit: async () => ({ success: true }) };
    const testEnv = { ...env, AUTH: fakeAuth("userA", FULL_CAPS), AUTH_LIMITER: passingLimiter };
    const res = await app.request(
      "/api/v2/me",
      { headers: { "CF-Connecting-IP": uniqueIp() } },
      testEnv,
    );
    expect(res.status).toBe(200);
  });

  it("EXTERNAL_LIMITER runs BEFORE session: rejected → 429, not 401 (no auth RPC)", async () => {
    const rejecting = { limit: async () => ({ success: false }) };
    // nullAuth would 401 if sessionMiddleware ran first; a 429 proves the limiter
    // short-circuits before any AUTH.verifySession / caps KV write.
    const testEnv = { ...env, AUTH: nullAuth(), EXTERNAL_LIMITER: rejecting };
    const res = await app.request(
      "/api/v2/external/search?source_type=instructor&keyword=x",
      { headers: { "CF-Connecting-IP": uniqueIp() } },
      testEnv,
    );
    expect(res.status).toBe(429);
  });
});

describe("CORS preflight", () => {
  it("OPTIONS to a link path with PATCH method → allows PATCH", async () => {
    const res = await request(
      "/api/v2/subscriptions/x/links/y",
      fakeAuth("userA", FULL_CAPS),
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "PATCH",
        },
      },
      // Shared test env inherits ENVIRONMENT=production; these preflight
      // cases exercise the dev-origin path.
      { ENVIRONMENT: "development" },
    );
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowMethods).toContain("PATCH");
  });

  it("OPTIONS to notification settings allows PUT", async () => {
    const res = await request(
      "/api/v2/notification-settings",
      fakeAuth("userA", FULL_CAPS),
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "PUT",
        },
      },
      { ENVIRONMENT: "development" },
    );
    expect(res.headers.get("access-control-allow-methods") ?? "").toContain("PUT");
  });
});

describe("CORS localhost policy (#90)", () => {
  it("production: localhost and 127.0.0.1 origins get no ACAO header", async () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      const res = await request(
        "/api/v2/health",
        fakeAuth("userA", FULL_CAPS),
        { headers: { Origin: origin } },
        { ENVIRONMENT: "production" },
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it.each(["development", "preview"])("%s: localhost origin still allowed", async (environment) => {
    const res = await request(
      "/api/v2/health",
      fakeAuth("userA", FULL_CAPS),
      { headers: { Origin: "http://localhost:5173" } },
      { ENVIRONMENT: environment },
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});
