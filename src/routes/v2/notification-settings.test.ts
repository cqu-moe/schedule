import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { SessionEnv } from "../../middleware/session";
import { businessIdentity as sessionMiddleware } from "../../test-utils/business-identity";
import type { AuthService, CalendarCaps, VerifiedSession } from "../../services/auth-rpc";
import notificationSettings from "./notification-settings";

const caps = (changeNotification: boolean): CalendarCaps => ({
  sync: true,
  external: false,
  share: false,
  change_notification: changeNotification,
  sub_limit: 10,
  share_limit: 0,
  sync_interval: 60,
  manual_refresh: 5,
});

function auth(userId: string, changeNotification: boolean): AuthService {
  const session: VerifiedSession = {
    user: { id: userId, name: "测试", email: `${userId}@cqu.moe`, role: "user" },
    caps: { calendar: caps(changeNotification) },
  };
  return {
    async verifySession() { return session; },
    async getCquTicket() { return { error: "NOT_USED" }; },
  };
}

function buildApp(userId: string, eligible: boolean) {
  const app = new Hono<SessionEnv>();
  app.use("*", sessionMiddleware);
  app.route("/", notificationSettings);
  const testEnv = { ...env, AUTH: auth(userId, eligible) };
  return (path = "/", init?: RequestInit) => app.request(path, init, testEnv);
}

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS notification_state").run();
  await env.DB.prepare(`CREATE TABLE notification_state (
    user_id text PRIMARY KEY NOT NULL,
    enabled integer NOT NULL DEFAULT 0,
    snapshot_json text,
    snapshot_hash text, pending_notification_json text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM notification_state").run();
});

describe("notification settings", () => {
  it("defaults to disabled and reports current eligibility", async () => {
    const res = await buildApp("user-1", true)();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible: true, enabled: false });
  });

  it("allows an eligible user to enable and persists per user", async () => {
    const request = buildApp("user-1", true);
    const put = await request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ eligible: true, enabled: true });
    expect(await (await request()).json()).toEqual({ eligible: true, enabled: true });
    expect(await (await buildApp("user-2", true)()).json()).toEqual({ eligible: true, enabled: false });
  });

  it("rejects enabling without the entitlement but always allows disabling", async () => {
    const ineligible = buildApp("user-1", false);
    const denied = await ineligible("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(denied.status).toBe(403);

    const disable = await ineligible("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toEqual({ eligible: false, enabled: false });
  });

  it("rejects invalid request bodies", async () => {
    const res = await buildApp("user-1", true)("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});
