import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { businessIdentity as sessionMiddleware } from "../../test-utils/business-identity";
import type {
  AuthService,
  CalendarCaps,
  VerifiedSession,
} from "../../services/auth-rpc";
import { CQUAPIClient } from "../../services/cqu-api";
import externalV2 from "./external";

// ── caps presets ─────────────────────────────────────────────────────────────

const FULL_CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  sub_limit: 10,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

function capsWith(overrides: Partial<CalendarCaps>): CalendarCaps {
  return { ...FULL_CAPS, ...overrides };
}

/** Build a fake AUTH binding whose verifySession returns a session for `userId`/`caps`. */
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
      // Default: no ticket. Tests that need a bearer mock getCquBearer directly.
      return { error: "NOT_USED" };
    },
  };
}

// The routes are wrapped in `rateLimit("EXTERNAL_LIMITER")`, a REAL limiter
// binding from `cloudflare:test` keyed on `CF-Connecting-IP` (limit 10 / 60s).
// With no header every request shares the "unknown" bucket and the suite would
// trip 429. Give each request a unique IP so the limiter never interferes.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 254}.${ipCounter}`;
}

/** Build a Hono app: sessionMiddleware (with the given AUTH) → v2 external. */
function buildApp(userId: string, caps: CalendarCaps = FULL_CAPS) {
  const app = new Hono<SessionEnv>();
  app.use("*", sessionMiddleware);
  app.route("/", externalV2);
  const testEnv = { ...env, AUTH: fakeAuth(userId, caps) };
  return {
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("CF-Connecting-IP", uniqueIp());
      return app.request(path, { ...init, headers }, testEnv);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 外部课表软禁用(EXTERNAL_DISABLED=true)─────────────────────────────────────
//  瑞数全站化后外部课表无法 harvest;端点统一返回 503 EXTERNAL_UNAVAILABLE,
//  在 cap/bearer/CQU 调用之前短路,绝不暴露 WAF。恢复只需翻 EXTERNAL_DISABLED。
describe("external soft-disabled", () => {
  it("GET /search → 503 EXTERNAL_UNAVAILABLE (before any CQU call)", async () => {
    const spy = vi.spyOn(CQUAPIClient.prototype, "searchInstructor");
    const app = buildApp("userA");
    const res = await app.request("/search?source_type=instructor&keyword=张");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("EXTERNAL_UNAVAILABLE");
    expect(spy).not.toHaveBeenCalled();
  });

  it("GET /departments → 503 EXTERNAL_UNAVAILABLE", async () => {
    const app = buildApp("userA");
    const res = await app.request("/departments");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("EXTERNAL_UNAVAILABLE");
  });
});
