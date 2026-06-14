import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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

/** Insert a calendar_links row directly (bypasses the route) for fixture setup. */
async function insertLink(
  subscriptionId: string,
  overrides: Partial<typeof calendarLinks.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(calendarLinks).values({
    id,
    subscriptionId,
    token: `tok-${id}`,
    formats: JSON.stringify(["ics"]),
    isDefault: false,
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

  it("SECURITY: pins personal sourceId to the auth user.id, ignoring client input", async () => {
    const app = buildApp("userA");
    // Client tries to bind the personal subscription to ANOTHER student's 学号.
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "personal_all", sourceId: "20219999", sourceName: "我的课表" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; source_id: string };
    // Response and DB must store the trusted user.id, not the forged 学号.
    expect(body.source_id).toBe("userA");

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, body.id));
    expect(row.sourceId).toBe("userA");
  });

  it("keeps the client-supplied sourceId for explore (external) source types", async () => {
    const app = buildApp("userA");
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "instructor", sourceId: "T-42", sourceName: "张老师" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; source_id: string };
    expect(body.source_id).toBe("T-42");

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, body.id));
    expect(row.sourceId).toBe("T-42");
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

  it("rejects overly long session fields → 400 INVALID_INPUT", async () => {
    const app = buildApp("userA");
    const res = await app.request(
      "/",
      jsonBody({ ...VALID_CREATE, sessionName: "x".repeat(201) }),
    );
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

// ── E2: GET /:sid/links and /:sid/links/:lid ─────────────────────────────────

describe("GET /api/v2/subscriptions/:sid/links", () => {
  it("lists all links for the subscription, default first", async () => {
    const subId = await insertSub("userA");
    await insertLink(subId, { token: "share-1", isDefault: false });
    await insertLink(subId, {
      token: "default-1",
      isDefault: true,
      formats: JSON.stringify([...LINK_FORMATS]),
    });

    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      links: { token: string; is_default: boolean }[];
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.links[0].token).toBe("default-1");
    expect(body.links[0].is_default).toBe(true);
    expect(body.links[1].token).toBe("share-1");
  });

  it("returns 404 listing links of another user's subscription", async () => {
    const subId = await insertSub("userB");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links`);
    expect(res.status).toBe(404);
  });

  it("gets a single link", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId, { token: "single" });
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; token: string };
    expect(body.id).toBe(lid);
    expect(body.token).toBe("single");
  });

  it("returns 404 for a link not belonging to the subscription", async () => {
    const subId = await insertSub("userA");
    const otherSub = await insertSub("userA", { sourceId: "999" });
    const lid = await insertLink(otherSub);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 getting a link of another user's subscription", async () => {
    const subId = await insertSub("userB");
    const lid = await insertLink(subId);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`);
    expect(res.status).toBe(404);
  });
});

// ── E3: POST /:sid/links (create share link) ─────────────────────────────────

describe("POST /api/v2/subscriptions/:sid/links", () => {
  it("creates a share link → 201 + Location + correct formats stored", async () => {
    const subId = await insertSub("userA");
    const app = buildApp("userA");
    const res = await app.request(
      `/${subId}/links`,
      jsonBody({ label: "给同学", formats: ["ics", "web"] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      token: string;
      label: string | null;
      formats: string[];
      is_default: boolean;
    };
    expect(res.headers.get("Location")).toBe(
      `/api/v2/subscriptions/${subId}/links/${body.id}`,
    );
    expect(body.label).toBe("给同学");
    expect(body.formats).toEqual(["ics", "web"]);
    expect(body.is_default).toBe(false);

    const rows = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].isDefault).toBe(false);
    expect(JSON.parse(rows[0].formats)).toEqual(["ics", "web"]);
  });

  it("allows a missing label (null)", async () => {
    const subId = await insertSub("userA");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links`, jsonBody({ formats: ["csv"] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { label: string | null };
    expect(body.label).toBeNull();
  });

  it("without `share` cap → 403 FEATURE_NOT_ENABLED", async () => {
    const subId = await insertSub("userA");
    const app = buildApp("userA", capsWith({ share: false }));
    const res = await app.request(`/${subId}/links`, jsonBody({ formats: ["ics"] }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FEATURE_NOT_ENABLED");
  });

  it("share_limit counts across all subscriptions → 409 QUOTA_EXCEEDED", async () => {
    // Two subscriptions for userA, one share link on each → 2 total.
    const sub1 = await insertSub("userA", { sourceId: "111" });
    const sub2 = await insertSub("userA", { sourceId: "222" });
    await insertLink(sub1, { token: "s1", isDefault: false });
    await insertLink(sub2, { token: "s2", isDefault: false });
    // A default link must NOT count toward the limit.
    await insertLink(sub1, { token: "d1", isDefault: true });

    const app = buildApp("userA", capsWith({ share_limit: 2 }));
    const res = await app.request(`/${sub1}/links`, jsonBody({ formats: ["ics"] }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("QUOTA_EXCEEDED");
  });

  it("invalid formats → 400 INVALID_FORMATS", async () => {
    const subId = await insertSub("userA");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links`, jsonBody({ formats: ["bogus"] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_FORMATS");
  });

  it("empty formats → 400 INVALID_FORMATS", async () => {
    const subId = await insertSub("userA");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links`, jsonBody({ formats: [] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_FORMATS");
  });

  it("returns 404 creating a link on another user's subscription", async () => {
    const subId = await insertSub("userB");
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links`, jsonBody({ formats: ["ics"] }));
    expect(res.status).toBe(404);
  });

  it("rejects an overly long label → 400", async () => {
    const subId = await insertSub("userA");
    const app = buildApp("userA");
    const res = await app.request(
      `/${subId}/links`,
      jsonBody({ label: "x".repeat(101), formats: ["ics"] }),
    );
    expect(res.status).toBe(400);
  });
});

// ── E4: PATCH /:sid/links/:lid ───────────────────────────────────────────────

describe("PATCH /api/v2/subscriptions/:sid/links/:lid", () => {
  it("updates label and formats of a share link", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId, { label: "old", formats: JSON.stringify(["ics"]) });
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "new", formats: ["web", "csv"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string; formats: string[] };
    expect(body.label).toBe("new");
    expect(body.formats).toEqual(["web", "csv"]);

    const [row] = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.id, lid));
    expect(row.label).toBe("new");
    expect(JSON.parse(row.formats)).toEqual(["web", "csv"]);
  });

  it("rejects patching the default link → 403 DEFAULT_LINK_IMMUTABLE", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId, { isDefault: true });
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("DEFAULT_LINK_IMMUTABLE");
  });

  it("rejects invalid formats on patch → 400 INVALID_FORMATS", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formats: ["bogus"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_FORMATS");
  });

  it("returns 404 patching another user's link", async () => {
    const subId = await insertSub("userB");
    const lid = await insertLink(subId);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

// ── E5: DELETE /:sid/links/:lid ──────────────────────────────────────────────

describe("DELETE /api/v2/subscriptions/:sid/links/:lid", () => {
  it("deletes a share link → 204", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.id, lid));
    expect(rows).toHaveLength(0);
  });

  it("rejects deleting the default link → 403 DEFAULT_LINK_IMMUTABLE", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId, { isDefault: true });
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("DEFAULT_LINK_IMMUTABLE");

    const rows = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.id, lid));
    expect(rows).toHaveLength(1);
  });

  it("returns 404 deleting another user's link", async () => {
    const subId = await insertSub("userB");
    const lid = await insertLink(subId);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── E6: POST /:sid/links/:lid/rotations ──────────────────────────────────────

describe("POST /api/v2/subscriptions/:sid/links/:lid/rotations", () => {
  it("rotates the token: old token gone, new token present → 201", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId, { token: "old-token" });
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}/rotations`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    expect(body.token).not.toBe("old-token");

    // Old token must be gone; new token present on the same row.
    const [row] = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.id, lid));
    expect(row.token).toBe(body.token);
    expect(row.token).not.toBe("old-token");

    const oldRows = await db
      .select()
      .from(calendarLinks)
      .where(eq(calendarLinks.token, "old-token"));
    expect(oldRows).toHaveLength(0);
  });

  it("allows rotating the default link's token", async () => {
    const subId = await insertSub("userA");
    const lid = await insertLink(subId, { token: "default-old", isDefault: true });
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}/rotations`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    expect(body.token).not.toBe("default-old");
  });

  it("returns 404 rotating another user's link", async () => {
    const subId = await insertSub("userB");
    const lid = await insertLink(subId);
    const app = buildApp("userA");
    const res = await app.request(`/${subId}/links/${lid}/rotations`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

// ── G3: POST /:sid/syncs (manual refresh + per-day quota) ─────────────────────

describe("POST /api/v2/subscriptions/:sid/syncs", () => {
  /** Build an app whose env injects a mock SCHEDULE_SYNC_QUEUE.send spy. */
  function buildSyncApp(userId: string, caps: CalendarCaps = FULL_CAPS) {
    const send = vi.fn().mockResolvedValue(undefined);
    const app = new Hono<SessionEnv>();
    app.use("*", sessionMiddleware);
    app.route("/", subscriptionsV2);
    const testEnv = {
      ...env,
      AUTH: fakeAuth(userId, caps),
      SCHEDULE_SYNC_QUEUE: { send },
    };
    return {
      send,
      request(path: string, init?: RequestInit) {
        return app.request(path, { method: "POST", ...init }, testEnv);
      },
    };
  }

  /** China-local date key matching the route's counter key. */
  function dayKey(): string {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  beforeEach(async () => {
    await env.CACHE.delete(`refresh:userA:${dayKey()}`);
  });

  it("enqueues a sync and returns 202", async () => {
    const sid = await insertSub("userA");
    const app = buildSyncApp("userA");
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(202);
    expect(app.send).toHaveBeenCalledWith({ subscriptionId: sid, userId: "userA" });
  });

  it("returns 404 for another user's subscription (no enqueue)", async () => {
    const sid = await insertSub("userB");
    const app = buildSyncApp("userA");
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(404);
    expect(app.send).not.toHaveBeenCalled();
  });

  it("returns 429 when the daily manual_refresh quota is exhausted", async () => {
    const sid = await insertSub("userA");
    // Pre-seed today's counter at the cap.
    await env.CACHE.put(`refresh:userA:${dayKey()}`, "2");
    const app = buildSyncApp("userA", capsWith({ manual_refresh: 2 }));
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("RATE_LIMITED");
    expect(app.send).not.toHaveBeenCalled();
  });

  it("manual_refresh = 0 disables manual refresh → 429", async () => {
    const sid = await insertSub("userA");
    const app = buildSyncApp("userA", capsWith({ manual_refresh: 0 }));
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(429);
    expect(app.send).not.toHaveBeenCalled();
  });

  it("manual_refresh = null means unlimited (no counter gate)", async () => {
    const sid = await insertSub("userA");
    // Even with a high pre-seeded counter, unlimited never rate-limits.
    await env.CACHE.put(`refresh:userA:${dayKey()}`, "9999");
    const app = buildSyncApp("userA", capsWith({ manual_refresh: null }));
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(202);
    expect(app.send).toHaveBeenCalledOnce();
  });

  it("increments the counter so a second refresh at limit=1 is blocked", async () => {
    const sid = await insertSub("userA");
    const app = buildSyncApp("userA", capsWith({ manual_refresh: 1 }));

    const first = await app.request(`/${sid}/syncs`);
    expect(first.status).toBe(202);

    const second = await app.request(`/${sid}/syncs`);
    expect(second.status).toBe(429);
    expect(app.send).toHaveBeenCalledOnce();
  });
});
