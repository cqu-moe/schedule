import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { subscriptions, calendarLinks, LINK_FORMATS } from "../../db/schema";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session";
import type {
  AuthService,
  CalendarCaps,
  VerifiedSession,
} from "../../services/auth-rpc";
import subscriptionsV2 from "./subscriptions";

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
      return { error: "NOT_USED" };
    },
  };
}

/** Build a Hono app: sessionMiddleware (with the given AUTH) → v2 subscriptions. */
function buildApp(userId: string, caps: CalendarCaps = FULL_CAPS) {
  const app = new Hono<SessionEnv>();
  app.use("*", sessionMiddleware);
  app.route("/", subscriptionsV2);
  const testEnv = { ...env, AUTH: fakeAuth(userId, caps) };
  return {
    request(path: string, init?: RequestInit) {
      return app.request(path, init, testEnv);
    },
  };
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const VALID_CREATE = {
  sourceType: "personal_all",
  sourceId: "20210001",
  sourceName: "我的课表",
};

const db = drizzle(env.DB);

// ── DB setup (real D1 from cloudflare:test) ──────────────────────────────────

beforeAll(async () => {
  // Drop legacy tables (other test files create `users`/old subscriptions).
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS subscriptions").run();

  await env.DB.prepare(
    `CREATE TABLE subscriptions (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      source_type text NOT NULL,
      source_id text NOT NULL,
      source_name text NOT NULL,
      session_id text,
      session_name text,
      semester_start text,
      is_personal integer NOT NULL DEFAULT 0,
      ics_content text,
      courses_json text,
      exams_json text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX uq_user_source_session ON subscriptions (user_id, source_type, source_id, session_id)`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX idx_subscriptions_user_id ON subscriptions (user_id)`,
  ).run();

  await env.DB.prepare(
    `CREATE TABLE calendar_links (
      id text PRIMARY KEY NOT NULL,
      subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      token text NOT NULL,
      label text,
      formats text NOT NULL,
      is_default integer NOT NULL DEFAULT 0,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX calendar_links_token_unique ON calendar_links (token)`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX idx_calendar_links_subscription_id ON calendar_links (subscription_id)`,
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM subscriptions").run();
});

/** Insert a subscription row directly (bypasses the route) for fixture setup. */
async function insertSub(userId: string, overrides: Partial<typeof subscriptions.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(subscriptions).values({
    id,
    userId,
    sourceType: "personal_all",
    sourceId: "20210001",
    sourceName: "fixture",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

// ── GET / (list) ─────────────────────────────────────────────────────────────

describe("GET /api/v2/subscriptions", () => {
  it("returns only the current user's subscriptions", async () => {
    const mine = await insertSub("userA", { sourceId: "111", sourceName: "A1" });
    await insertSub("userB", { sourceId: "222", sourceName: "B1" });

    const app = buildApp("userA");
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: { id: string; user_id: string }[];
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.subscriptions[0].id).toBe(mine);
    expect(body.subscriptions[0].user_id).toBe("userA");
  });

  it("includes link summaries for each subscription", async () => {
    const subId = await insertSub("userA");
    await db.insert(calendarLinks).values({
      id: crypto.randomUUID(),
      subscriptionId: subId,
      token: "tok-default",
      formats: JSON.stringify([...LINK_FORMATS]),
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = buildApp("userA");
    const res = await app.request("/");
    const body = (await res.json()) as {
      subscriptions: { links: { token: string; formats: string[]; is_default: boolean }[] }[];
    };
    const links = body.subscriptions[0].links;
    expect(links).toHaveLength(1);
    expect(links[0].token).toBe("tok-default");
    expect(links[0].is_default).toBe(true);
    expect(links[0].formats).toEqual([...LINK_FORMATS]);
  });
});

// ── GET /:sid ────────────────────────────────────────────────────────────────

describe("GET /api/v2/subscriptions/:sid", () => {
  it("returns the subscription with its links", async () => {
    const subId = await insertSub("userA");
    await db.insert(calendarLinks).values({
      id: crypto.randomUUID(),
      subscriptionId: subId,
      token: "tok-1",
      formats: JSON.stringify(["ics"]),
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = buildApp("userA");
    const res = await app.request(`/${subId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; links: { token: string }[] };
    expect(body.id).toBe(subId);
    expect(body.links[0].token).toBe("tok-1");
  });

  it("returns 404 for another user's subscription", async () => {
    const subId = await insertSub("userB");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent subscription", async () => {
    const app = buildApp("userA");
    const res = await app.request("/does-not-exist");
    expect(res.status).toBe(404);
  });
});

// ── POST / (create) ──────────────────────────────────────────────────────────

describe("POST /api/v2/subscriptions", () => {
  it("creates a subscription + default all-format link → 201 + Location", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody(VALID_CREATE));
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toMatch(/^\/api\/v2\/subscriptions\//);

    const body = (await res.json()) as {
      id: string;
      links: { is_default: boolean; formats: string[] }[];
    };
    expect(res.headers.get("Location")).toBe(`/api/v2/subscriptions/${body.id}`);
    expect(body.links).toHaveLength(1);
    expect(body.links[0].is_default).toBe(true);
    expect(body.links[0].formats).toEqual([...LINK_FORMATS]);

    // Verify persisted: exactly one default, full-format link in DB.
    const links = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.subscriptionId, body.id));
    expect(links).toHaveLength(1);
    expect(links[0].isDefault).toBe(true);
    expect(JSON.parse(links[0].formats)).toEqual([...LINK_FORMATS]);
  });

  it("rejects invalid sourceType → 400 INVALID_INPUT", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody({ ...VALID_CREATE, sourceType: "bogus" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_INPUT");
  });

  it("rejects missing sourceId → 400 INVALID_INPUT", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody({ sourceType: "personal_all", sourceName: "x" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_INPUT");
  });

  it("external source without `external` cap → 403", async () => {
    const app = buildApp("userA", capsWith({ external: false }));
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "instructor", sourceId: "T1", sourceName: "张老师" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FEATURE_NOT_ENABLED");
  });

  it("personal source without `sync` cap → 403", async () => {
    const app = buildApp("userA", capsWith({ sync: false }));
    const res = await app.request("/", jsonBody(VALID_CREATE));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FEATURE_NOT_ENABLED");
  });

  it("over sub_limit → 409 QUOTA_EXCEEDED", async () => {
    await insertSub("userA", { sourceId: "111" });
    const app = buildApp("userA", capsWith({ sub_limit: 1 }));
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "personal_courses", sourceId: "222", sourceName: "课程" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("QUOTA_EXCEEDED");
  });

  it("duplicate (same user/source/session) → 409 ALREADY_EXISTS", async () => {
    const app = buildApp("userA");
    const first = await app.request("/", jsonBody(VALID_CREATE));
    expect(first.status).toBe(201);

    const dup = await app.request("/", jsonBody(VALID_CREATE));
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("ALREADY_EXISTS");
  });

  it("rejects malformed JSON → 400 INVALID_INPUT", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /:sid ─────────────────────────────────────────────────────────────

describe("DELETE /api/v2/subscriptions/:sid", () => {
  it("deletes the subscription and cascades its links → 204", async () => {
    const app = buildApp("userA");
    const created = await app.request("/", jsonBody(VALID_CREATE));
    const { id } = (await created.json()) as { id: string };

    // Sanity: link exists before delete.
    const before = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.subscriptionId, id));
    expect(before).toHaveLength(1);

    const res = await app.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const subsAfter = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, id));
    expect(subsAfter).toHaveLength(0);

    const linksAfter = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.subscriptionId, id));
    expect(linksAfter).toHaveLength(0);
  });

  it("returns 404 when deleting another user's subscription", async () => {
    const subId = await insertSub("userB");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}`, { method: "DELETE" });
    expect(res.status).toBe(404);

    // userB's subscription must remain.
    const still = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subId));
    expect(still).toHaveLength(1);
  });
});
