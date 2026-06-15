import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "./session";
import type { AuthService, VerifiedSession } from "../services/auth-rpc";

const VALID_SESSION: VerifiedSession = {
  user: { id: "user123", name: "测试", email: "test@cqu.moe", role: "user" },
  caps: {
    calendar: {
      sync: true,
      external: true,
      share: true,
      sub_limit: 10,
      share_limit: 20,
      sync_interval: 60,
      manual_refresh: 20,
    },
  },
};

/** Build a fake AUTH service binding whose verifySession returns the given value. */
function fakeAuth(result: VerifiedSession | null): AuthService {
  return {
    async verifySession() {
      return result;
    },
    async getCquTicket() {
      return { error: "NOT_USED" };
    },
  };
}

/** Build a Hono app with sessionMiddleware + a probe route that echoes the context. */
function buildApp(auth: AuthService) {
  const app = new Hono<SessionEnv>();
  app.use("*", sessionMiddleware);
  app.get("/probe", (c) =>
    c.json({ user: c.get("user"), caps: c.get("caps") }),
  );
  // No ExecutionContext is passed, so the middleware awaits the caps KV write
  // (its non-fetch fallback) — it completes within the request, no storage leak.
  return {
    request(testEnv = { ...env, AUTH: auth }) {
      return app.request("/probe", { method: "GET" }, testEnv);
    },
  };
}

describe("sessionMiddleware", () => {
  beforeEach(async () => {
    // Clear any caps caches left by previous tests.
    await env.CACHE.delete(`caps:${VALID_SESSION.user.id}`);
  });

  it("returns 401 when verifySession returns null", async () => {
    const app = buildApp(fakeAuth(null));
    const res = await app.request();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("UNAUTHORIZED");
  });

  it("injects user/caps and calls next when session is valid", async () => {
    const app = buildApp(fakeAuth(VALID_SESSION));
    const res = await app.request();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: typeof VALID_SESSION.user;
      caps: typeof VALID_SESSION.caps;
    };
    expect(body.user).toEqual(VALID_SESSION.user);
    expect(body.caps).toEqual(VALID_SESSION.caps);
  });

  it("caches caps to KV under caps:<userId> when session is valid", async () => {
    const app = buildApp(fakeAuth(VALID_SESSION));
    const res = await app.request();
    expect(res.status).toBe(200);

    const cached = await env.CACHE.get(`caps:${VALID_SESSION.user.id}`);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual(VALID_SESSION.caps.calendar);
  });
});
