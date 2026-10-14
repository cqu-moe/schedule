import { applyD1Migrations, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index";
import { oauthProvider } from "../test-utils/oauth-provider";
import type { Env } from "../types";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const identity = { user: { id: "alice", name: "Alice", email: "alice@example.com", role: "user" }, caps: { calendar: {
  sync: true, external: true, share: false, change_notification: false, sub_limit: 3, share_limit: 0, sync_interval: 60, manual_refresh: 3,
} } };
const cookie = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];

describe("Schedule browser session", () => {
  it("accepts old and explicit external entitlement fields but rejects an invalid interval contract", async () => {
    const external = {
      external_sync_interval: 0,
      external_manual_refresh: null,
    };
    const provider = await oauthProvider({
      ...identity,
      caps: { calendar: { ...identity.caps.calendar, ...external } },
    });
    const testEnv = { ...env, AUTH_ORIGIN: provider.origin, PUBLIC_URL: "https://schedule.test", CALENDAR_CLIENT_ID: "calendar", CALENDAR_CLIENT_SECRET: "test-secret" } as Env;
    const start = await app.request("/api/v2/auth/login", {}, testEnv);
    const callback = provider.authorize(start.headers.get("location")!);
    const finish = await app.request(callback.href, { headers: { cookie: cookie(start) } }, testEnv);
    const headers = { cookie: cookie(finish) };
    const current = await app.request("/api/v2/me", { headers }, testEnv);
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      caps: { calendar: { ...identity.caps.calendar, ...external } },
    });

    provider.faults.authority = {
      caps: { calendar: { ...identity.caps.calendar, external_sync_interval: null } },
    };
    expect((await app.request("/api/v2/me", { headers }, testEnv)).status).toBe(503);
    provider.faults.authority = {
      caps: { calendar: { ...identity.caps.calendar, external_manual_refresh: 1.5 } },
    };
    expect((await app.request("/api/v2/me", { headers }, testEnv)).status).toBe(503);
  });

  it("logs in through PKCE and a browser-bound callback, uses a host-only session, and observes central revocation", async () => {
    const provider = await oauthProvider(identity);
    const testEnv = { ...env, AUTH_ORIGIN: provider.origin, PUBLIC_URL: "https://schedule.test", CALENDAR_CLIENT_ID: "calendar", CALENDAR_CLIENT_SECRET: "test-secret" } as Env;
    const request = async (path: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const response = await app.request(new URL(path, testEnv.PUBLIC_URL), init, testEnv, ctx);
      await waitOnExecutionContext(ctx); return response;
    };
    const start = await request("/api/v2/auth/login?returnTo=/dashboard");
    expect(start.status).toBe(302);
    const callback = provider.authorize(start.headers.get("location")!);
    const finish = await request(callback.toString(), { headers: { cookie: cookie(start) } });
    expect(finish.status).toBe(302);
    expect(finish.headers.get("location")).toBe("/dashboard");
    const cookies = finish.headers.get("set-cookie")!;
    expect(cookies).toContain("HttpOnly"); expect(cookies).toContain("Secure"); expect(cookies).not.toContain("Domain=");
    const sessionCookie = cookie(finish);
    expect(sessionCookie).not.toContain("access_token");
    const me = await request("/api/v2/me", { headers: { cookie: sessionCookie } });
    expect(me.status).toBe(200);
    const oldContract = await me.json() as { caps: { calendar: Record<string, unknown> } };
    expect(oldContract).toMatchObject(identity);
    expect(oldContract.caps.calendar).not.toHaveProperty("external_sync_interval");
    expect(oldContract.caps.calendar).not.toHaveProperty("external_manual_refresh");
    for (const status of ["pending", "revoked", "unbound", "deleting"]) {
      provider.faults.authority = { cquBindStatus: status };
      const current = await request("/api/v2/me", { headers: { cookie: sessionCookie } });
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({ cquBindStatus: status });
      const defaults = await request("/api/v2/subscriptions/defaults", {
        method: "POST", headers: { cookie: sessionCookie, origin: testEnv.PUBLIC_URL },
      });
      expect(defaults.status).toBe(409);
      expect(await defaults.json()).toMatchObject({ detail: { error: { code: "CQU_BINDING_REQUIRED" } } });
    }
    provider.faults.authority = { cquBindStatus: "active" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 601000);
    const concurrent = await Promise.all([1, 2].map(() => request("/api/v2/me", { headers: { cookie: sessionCookie } })));
    expect(concurrent.some(response => response.status === 200)).toBe(true);
    expect(concurrent.every(response => [200, 503].includes(response.status))).toBe(true);
    expect((await request("/api/v2/me", { headers: { cookie: sessionCookie } })).status).toBe(200);
    expect(JSON.parse((await env.CACHE.get("caps:alice"))!)).toEqual(identity.caps.calendar);
    provider.revoke();
    expect((await request("/api/v2/me", { headers: { cookie: sessionCookie } })).status).toBe(401);
  });
  it("rejects callback substitution and replay, and local logout leaves central login usable", async () => {
    const provider = await oauthProvider(identity);
    const testEnv = { ...env, AUTH_ORIGIN: provider.origin, PUBLIC_URL: "https://schedule.test", CALENDAR_CLIENT_ID: "calendar", CALENDAR_CLIENT_SECRET: "test-secret" } as Env;
    const request = (path: string, init?: RequestInit) => app.request(new URL(path, testEnv.PUBLIC_URL), init, testEnv);
    const start = await request("/api/v2/auth/login?returnTo=https://evil.test");
    const callback = provider.authorize(start.headers.get("location")!);
    expect((await request(callback.href)).status).toBe(400);
    const wrongState = new URL(callback); wrongState.searchParams.set("state", "substituted");
    expect((await request(wrongState.href, { headers: { cookie: cookie(start) } })).status).toBe(400);
    const finish = await request(callback.href, { headers: { cookie: cookie(start) } });
    expect(finish.status).toBe(302); expect(finish.headers.get("location")).toBe("/dashboard");
    expect((await request(callback.href, { headers: { cookie: cookie(start) } })).status).toBe(400);
    const browser = cookie(finish);
    expect((await request("/api/v2/auth/logout", { method: "POST", headers: { cookie: browser, origin: "https://other.schedule.test" } })).status).toBe(403);
    const logout = await request("/api/v2/auth/logout", { method: "POST", headers: { cookie: browser, origin: testEnv.PUBLIC_URL } });
    expect(logout.status).toBe(303); expect(logout.headers.get("location")).toBe("/signed-out");
    expect((await request("/api/v2/me", { headers: { cookie: browser } })).status).toBe(401);
    const next = await request("/api/v2/auth/login");
    const again = await request(provider.authorize(next.headers.get("location")!).href, { headers: { cookie: cookie(next) } });
    expect(again.status).toBe(302);
    expect((await request("/api/v2/notification-settings", { method: "PUT", headers: { cookie: cookie(again), origin: "https://other.schedule.test", "content-type": "application/json" }, body: '{"enabled":false}' })).status).toBe(403);
  });

  it.each(["nonce", "issuer", "audience", "signature"])("rejects a compromised %s in the ID token", async kind => {
    const provider = await oauthProvider(identity);
    if (kind === "signature") provider.faults.corruptSignature = true;
    else provider.faults.claims = { [kind === "issuer" ? "iss" : kind === "audience" ? "aud" : "nonce"]: "wrong" };
    const testEnv = { ...env, AUTH_ORIGIN: provider.origin, PUBLIC_URL: "https://schedule.test", CALENDAR_CLIENT_ID: "calendar", CALENDAR_CLIENT_SECRET: "test-secret" } as Env;
    const start = await app.request("/api/v2/auth/login", {}, testEnv);
    const response = await app.request(provider.authorize(start.headers.get("location")!).href, { headers: { cookie: cookie(start) } }, testEnv);
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-schedule_session=");
  });

  it("fails closed on unavailable or mismatched authority, and does not accept a central cookie", async () => {
    const provider = await oauthProvider(identity);
    const testEnv = { ...env, AUTH_ORIGIN: provider.origin, PUBLIC_URL: "https://schedule.test", CALENDAR_CLIENT_ID: "calendar", CALENDAR_CLIENT_SECRET: "test-secret" } as Env;
    const start = await app.request("/api/v2/auth/login", {}, testEnv);
    const response = await app.request(provider.authorize(start.headers.get("location")!).href, { headers: { cookie: cookie(start) } }, testEnv);
    expect(response.status).toBe(302);
    const headers = { cookie: cookie(response) };
    provider.faults.authorityUnavailable = true;
    expect((await app.request("/api/v2/me", { headers }, testEnv)).status).toBe(503);
    provider.faults.authorityUnavailable = false;
    provider.faults.authority = { client_id: "another-application" };
    expect((await app.request("/api/v2/me", { headers }, testEnv)).status).toBe(503);
    provider.faults.authority = {};
    expect((await app.request("/api/v2/me", { headers }, testEnv)).status).toBe(200);
    expect((await app.request("/api/v2/me", { headers: { cookie: "better-auth.session_token=central-cookie" } }, testEnv)).status).toBe(401);
  });

});
