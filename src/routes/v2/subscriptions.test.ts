import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  subscriptions,
  calendarLinks,
  personalSubscriptionSetup,
  PERSONAL_VIEW_TYPES,
  LINK_FORMATS,
} from "../../db/schema";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session";
import type {
  AuthService,
  CalendarCaps,
  CquBindStatus,
  VerifiedSession,
} from "../../services/auth-rpc";
import type { DefaultSubscriptionsResponse } from "../../services/personal-subscription-setup";
import subscriptionsV2 from "./subscriptions";

// ── caps presets ─────────────────────────────────────────────────────────────

const FULL_CAPS: CalendarCaps = {
  sync: true,
  external: true,
  share: true,
  change_notification: true,
  sub_limit: 10,
  share_limit: 20,
  sync_interval: 60,
  manual_refresh: 20,
};

function capsWith(overrides: Partial<CalendarCaps>): CalendarCaps {
  return { ...FULL_CAPS, ...overrides };
}

/** Build a fake AUTH binding whose verifySession returns a session for `userId`/`caps`. */
function fakeAuth(
  userId: string,
  caps: CalendarCaps,
  cquBindStatus: CquBindStatus | undefined,
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

/** Build a Hono app: sessionMiddleware (with the given AUTH) → v2 subscriptions. */
function buildApp(
  userId: string,
  caps: CalendarCaps = FULL_CAPS,
  cquBindStatus: CquBindStatus | null = "active",
  database: D1Database = env.DB,
  personalMode?: "legacy" | "migration" | "enabled",
) {
  const send = vi.fn().mockResolvedValue(undefined);
  const app = new Hono<SessionEnv>();
  app.use("*", sessionMiddleware);
  app.route("/", subscriptionsV2);
  const testEnv = {
    ...env,
    DB: database,
    AUTH: fakeAuth(userId, caps, cquBindStatus ?? undefined),
    SCHEDULE_SYNC_QUEUE: { send },
    PERSONAL_SUBSCRIPTION_MODE: personalMode,
  };
  return {
    send,
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
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_setup").run();
  await env.DB.prepare("DROP TABLE IF EXISTS calendar_links").run();
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_views").run();
  await env.DB.prepare("DROP TABLE IF EXISTS personal_subscription_migration_backups").run();
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
      is_active integer NOT NULL DEFAULT 1,
      ics_content text,
      courses_json text,
      exams_json text,
      last_synced_at text,
      sync_status text NOT NULL DEFAULT 'idle',
      sync_run_id text,
      sync_trigger text,
      sync_requested_at text,
      sync_started_at text,
      sync_finished_at text,
      sync_error_code text,
      sync_error_message text,
      session_recovery_attempts integer NOT NULL DEFAULT 0,
      manual_refresh_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX uq_user_source_session ON subscriptions (user_id, source_type, source_id, session_id)`,
  ).run();
  // Partial unique index mirroring migrations 0004→0005: enforces personal-subscription
  // uniqueness by (user, type, source) for the personal source types, regardless of
  // session_id (which first sync overwrites to the current semester).
  await env.DB.prepare(
    `CREATE UNIQUE INDEX uq_user_source_personal ON subscriptions (user_id, source_type, source_id) WHERE source_type IN ('personal_all', 'personal_courses', 'personal_exams')`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX idx_subscriptions_user_id ON subscriptions (user_id)`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX uq_personal_subscription_user ON subscriptions (user_id) WHERE source_type='personal'`,
  ).run();

  await env.DB.prepare(`CREATE TABLE personal_subscription_views (
    id text PRIMARY KEY NOT NULL,
    subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    source_type text NOT NULL,
    source_name text NOT NULL,
    created_at text NOT NULL,
    UNIQUE(subscription_id, source_type)
  )`).run();
  await env.DB.prepare(`CREATE TABLE personal_subscription_migration_backups (
    user_id text PRIMARY KEY NOT NULL, subscriptions_json text NOT NULL,
    links_json text NOT NULL, setup_json text, migrated_at text NOT NULL
  )`).run();

  await env.DB.prepare(
    `CREATE TABLE calendar_links (
      id text PRIMARY KEY NOT NULL,
      subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      token text NOT NULL,
      label text,
      formats text NOT NULL,
      personal_view_type text,
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
  await env.DB.prepare(`CREATE TABLE personal_subscription_setup (
    user_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created','existing')),
    subscription_ids TEXT NOT NULL DEFAULT '[]', run_id TEXT,
    dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending','sending','sent','failed')),
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_subscription_setup").run();
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM personal_subscription_views").run();
  await env.DB.prepare("DELETE FROM personal_subscription_migration_backups").run();
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

async function insertCanonicalPersonal(userId: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  await db.insert(subscriptions).values({
    id,
    userId,
    sourceType: "personal",
    sourceId: userId,
    sourceName: "个人课表",
    isPersonal: true,
    syncStatus: "success",
    syncRunId: runId,
    manualRefreshAt: now,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const viewIds: string[] = [];
  for (const sourceType of PERSONAL_VIEW_TYPES) {
    const viewId = crypto.randomUUID();
    viewIds.push(viewId);
    await env.DB.prepare(`INSERT INTO personal_subscription_views
      (id,subscription_id,source_type,source_name,created_at) VALUES (?,?,?,?,?)`)
      .bind(viewId, id, sourceType, sourceType, now)
      .run();
    await db.insert(calendarLinks).values({
      id: crypto.randomUUID(),
      subscriptionId: id,
      token: `canonical-${sourceType}-${userId}`,
      formats: JSON.stringify(LINK_FORMATS),
      personalViewType: sourceType,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { id, viewIds, runId, now };
}

// ── GET / (list) ─────────────────────────────────────────────────────────────

describe("GET /api/v2/subscriptions", () => {
  it("automatically provisions entitled built-in views in enabled mode", async () => {
    const app = buildApp(
      "auto-user",
      capsWith({ sub_limit: 0 }),
      "active",
      env.DB,
      "enabled",
    );
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json() as {
      count: number;
      subscriptions: Array<{ source_type: string; sync_run_id: string | null }>;
    };
    expect(body.count).toBe(3);
    expect(body.subscriptions.map((item) => item.source_type).sort()).toEqual([
      "personal_all",
      "personal_courses",
      "personal_exams",
    ]);
    expect(new Set(body.subscriptions.map((item) => item.sync_run_id)).size).toBe(1);
    expect(app.send).toHaveBeenCalledTimes(1);
  });

  it("projects one canonical personal row into three legacy-shaped views", async () => {
    const owner = await insertCanonicalPersonal("userA");
    await insertSub("userA", {
      sourceType: "instructor",
      sourceId: "teacher-1",
      sourceName: "教师课表",
      isPersonal: false,
    });

    const result = await (await buildApp("userA").request("/")).json() as {
      subscriptions: Array<{
        id: string;
        source_type: string;
        sync_run_id: string | null;
        manual_refresh_at: string | null;
        links: Array<{ token: string }>;
      }>;
      count: number;
    };

    const personal = result.subscriptions.filter((item) => item.source_type.startsWith("personal"));
    expect(result.count).toBe(4);
    expect(personal.map((item) => item.id).sort()).toEqual(owner.viewIds.sort());
    expect(personal.some((item) => item.source_type === "personal")).toBe(false);
    expect(new Set(personal.map((item) => item.sync_run_id))).toEqual(new Set([owner.runId]));
    expect(new Set(personal.map((item) => item.manual_refresh_at))).toEqual(new Set([owner.now]));
    expect(personal.every((item) => item.links.length === 1)).toBe(true);
  });

  it("resolves owned personal view IDs and hides them from other users", async () => {
    const owner = await insertCanonicalPersonal("userA");
    const mine = await buildApp("userA").request(`/${owner.viewIds[0]}`);
    expect(mine.status).toBe(200);
    const mineBody = await mine.json() as { id: string; source_type: string; links: unknown[] };
    expect(mineBody.id).toBe(owner.viewIds[0]);
    expect(mineBody.source_type).toBe("personal_all");
    expect(mineBody.links).toHaveLength(1);

    expect((await buildApp("userB").request(`/${owner.viewIds[0]}`)).status).toBe(404);
  });

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
    expect((body as typeof body & { personal_setup: unknown }).personal_setup).toBeNull();
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

  it("returns setup metadata without creating rows", async () => {
    const app = buildApp("userA");
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subscriptions: [],
      count: 0,
      personal_setup: null,
    });
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(0);
  });
});

// ── POST /defaults ──────────────────────────────────────────────────────────

describe("POST /api/v2/subscriptions/defaults", () => {
  it("initializes defaults through the authenticated route", async () => {
    const app = buildApp("userA");
    const response = await app.request("/defaults", { method: "POST" });
    expect(response.status).toBe(201);
    const body = await response.json() as DefaultSubscriptionsResponse;
    expect(body.subscription_ids).toHaveLength(3);
    expect(body.dispatch_status).toBe("sent");
    expect(app.send).toHaveBeenCalledTimes(1);

    const listResponse = await app.request("/");
    const list = await listResponse.json() as {
      subscriptions: { user_id: string }[];
      personal_setup: { status: string; dispatch_status: string };
    };
    expect(list.subscriptions).toHaveLength(3);
    expect(list.subscriptions.every((row) => row.user_id === "userA")).toBe(true);
    expect(list.personal_setup).toMatchObject({ status: "created", dispatch_status: "sent" });
  });

  it("requires an authenticated session", async () => {
    const app = new Hono<SessionEnv>();
    app.use("*", sessionMiddleware);
    app.route("/", subscriptionsV2);
    const response = await app.request("/defaults", { method: "POST" }, {
      ...env,
      AUTH: { verifySession: async () => null },
    } as unknown as Env);
    expect(response.status).toBe(401);
  });

  it("skips without sync capability before considering binding status", async () => {
    const app = buildApp("userA", capsWith({ sync: false }), "revoked");
    const response = await app.request("/defaults", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "skipped",
      subscription_ids: [],
      run_id: null,
      dispatch_status: "none",
    });
    expect(app.send).not.toHaveBeenCalled();
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(0);
  });

  it.each(["pending", "revoked", "unbound"] as const)(
    "rejects an explicitly %s CQU binding",
    async (cquBindStatus) => {
      const response = await buildApp("userA", FULL_CAPS, cquBindStatus)
        .request("/defaults", { method: "POST" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        detail: { error: { code: "CQU_BINDING_REQUIRED" } },
      });
      expect(await db.select().from(subscriptions)).toHaveLength(0);
    },
  );

  it("fails closed when an older Auth does not report binding status", async () => {
    const response = await buildApp("userA", FULL_CAPS, null)
      .request("/defaults", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      detail: { error: { code: "CQU_BINDING_STATUS_UNKNOWN" } },
    });
  });

  it("ignores injected identity and subscription fields", async () => {
    const app = buildApp("userA");
    const response = await app.request(
      "/defaults?userId=userB&sourceId=userB",
      jsonBody({ userId: "userB", sourceId: "userB", sourceTypes: ["instructor"] }),
    );
    expect(response.status).toBe(201);
    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.userId === "userA" && row.sourceId === "userA")).toBe(true);
  });

  it("returns the existing quota error without partial setup", async () => {
    const response = await buildApp("userA", capsWith({ sub_limit: 2 }))
      .request("/defaults", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      detail: { error: { code: "QUOTA_EXCEEDED" } },
    });
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await db.select().from(personalSubscriptionSetup)).toHaveLength(0);
  });

  it("does not rotate links or enqueue again after a sent setup", async () => {
    const app = buildApp("userA");
    const first = await app.request("/defaults", { method: "POST" });
    expect(first.status).toBe(201);
    const tokens = (await db.select().from(calendarLinks)).map((link) => link.token).sort();

    const second = await app.request("/defaults", { method: "POST" });
    expect(second.status).toBe(200);
    expect((await second.json() as DefaultSubscriptionsResponse).status).toBe("resumed");
    expect(app.send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(calendarLinks)).map((link) => link.token).sort()).toEqual(tokens);
  });

  it("persists setup idempotency across a new route client instance", async () => {
    const firstApp = buildApp("userA");
    const first = await firstApp.request("/defaults", { method: "POST" });
    expect(first.status).toBe(201);
    const tokens = (await db.select().from(calendarLinks)).map((link) => link.token).sort();

    const reloadedApp = buildApp("userA");
    const resumed = await reloadedApp.request("/defaults", { method: "POST" });
    expect(resumed.status).toBe(200);
    expect((await resumed.json() as DefaultSubscriptionsResponse).status).toBe("resumed");
    expect(reloadedApp.send).not.toHaveBeenCalled();
    expect(await db.select().from(subscriptions)).toHaveLength(3);
    expect((await db.select().from(calendarLinks)).map((link) => link.token).sort()).toEqual(tokens);
  });

  it("returns failed dispatch with all created rows when Queue send fails", async () => {
    const app = buildApp("userA");
    app.send.mockRejectedValueOnce(new Error("queue unavailable"));
    const response = await app.request("/defaults", { method: "POST" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: "created",
      subscription_ids: expect.arrayContaining([expect.any(String)]),
      dispatch_status: "failed",
    });
    expect(await db.select().from(subscriptions)).toHaveLength(3);
    expect(await db.select().from(calendarLinks)).toHaveLength(3);
  });

  it("maps an unrecoverable database failure to DEFAULT_SUBSCRIPTIONS_FAILED", async () => {
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async () => { throw new Error("forced batch failure"); }),
    } as unknown as D1Database;
    const response = await buildApp("userA", FULL_CAPS, "active", failingDb)
      .request("/defaults", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      detail: { error: {
        code: "DEFAULT_SUBSCRIPTIONS_FAILED",
        message: "订阅准备未完成，请重试。",
      } },
    });
  });

  it("does not allow deleting a legacy personal subscription", async () => {
    const legacyId = await insertSub("userA");
    const app = buildApp("userA");
    const deleted = await app.request(`/${legacyId}`, { method: "DELETE" });
    expect(deleted.status).toBe(403);
    expect(await db.select().from(subscriptions)).toHaveLength(1);
    expect(app.send).not.toHaveBeenCalled();
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
  it("rejects creating a managed personal subscription", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody(VALID_CREATE));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      detail: { error: { code: "PERSONAL_SUBSCRIPTION_MANAGED" } },
    });
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("does not enqueue when personal creation is rejected", async () => {
    // A fresh subscription must be populated promptly, not left empty until the
    // next hourly cron (which spreads deliveries over 6h).
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody(VALID_CREATE));
    expect(res.status).toBe(403);
    expect(app.send).not.toHaveBeenCalled();
  });

  it("rejects a personal type even if the client sends isPersonal=false", async () => {
    const app = buildApp("userA");
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "personal_all", sourceName: "我的课表", isPersonal: false }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects attempts to choose another identity for a managed personal subscription", async () => {
    const app = buildApp("userA");
    // Client tries to bind the personal subscription to ANOTHER student's 学号.
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "personal_all", sourceId: "20219999", sourceName: "我的课表" }),
    );
    expect(res.status).toBe(403);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("rejects invalid sourceType → 400 INVALID_INPUT", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody({ ...VALID_CREATE, sourceType: "bogus" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a personal subscription even when sourceId is omitted", async () => {
    const app = buildApp("userA");
    // Client omits sourceId entirely; personal types pin it to the auth user.id.
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "personal_all", sourceName: "我的课表" }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects missing sourceId for external source types → 400 INVALID_INPUT", async () => {
    const app = buildApp("userA");
    const res = await app.request("/", jsonBody({ sourceType: "instructor", sourceName: "x" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("INVALID_INPUT");
  });

  it("rejects managed personal creation before accepting mutable session fields", async () => {
    const app = buildApp("userA");
    const res = await app.request(
      "/",
      jsonBody({ ...VALID_CREATE, sessionName: "x".repeat(201) }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("PERSONAL_SUBSCRIPTION_MANAGED");
  });

  it("external add → 503 EXTERNAL_UNAVAILABLE (no DB write, no enqueue) while soft-disabled", async () => {
    const { request, send } = buildApp("userA");
    const res = await request(
      "/",
      jsonBody({ sourceType: "instructor", sourceId: "T-1", sourceName: "张老师" }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("EXTERNAL_UNAVAILABLE");
    expect(send).not.toHaveBeenCalled();

    // No subscription row created.
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.sourceType, "instructor"));
    expect(rows.length).toBe(0);
  });

  it("personal source remains managed even without the sync cap", async () => {
    const app = buildApp("userA", capsWith({ sync: false }));
    const res = await app.request("/", jsonBody(VALID_CREATE));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("PERSONAL_SUBSCRIPTION_MANAGED");
  });

  it("managed personal creation is rejected before quota accounting", async () => {
    await insertSub("userA", { sourceId: "111" });
    const app = buildApp("userA", capsWith({ sub_limit: 1 }));
    const res = await app.request(
      "/",
      jsonBody({ sourceType: "personal_courses", sourceId: "222", sourceName: "课程" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("PERSONAL_SUBSCRIPTION_MANAGED");
  });

  it("repeated managed personal creates remain forbidden", async () => {
    const app = buildApp("userA");
    const first = await app.request("/", jsonBody(VALID_CREATE));
    expect(first.status).toBe(403);

    const dup = await app.request("/", jsonBody(VALID_CREATE));
    expect(dup.status).toBe(403);
    const body = (await dup.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("PERSONAL_SUBSCRIPTION_MANAGED");
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
    const id = await insertSub("userA", {
      sourceType: "course",
      sourceId: "external-course",
      sourceName: "外部课程",
      isPersonal: false,
    });
    await insertLink(id, { isDefault: true });

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
  it("keeps canonical links isolated by the path view id", async () => {
    const owner = await insertCanonicalPersonal("userA");
    const app = buildApp("userA", FULL_CAPS, "active", env.DB, "enabled");
    const first = await app.request(`/${owner.viewIds[0]}/links`);
    const second = await app.request(`/${owner.viewIds[1]}/links`);
    const firstBody = await first.json() as { links: Array<{ token: string }> };
    const secondBody = await second.json() as { links: Array<{ token: string }> };
    expect(firstBody.links).toHaveLength(1);
    expect(secondBody.links).toHaveLength(1);
    expect(firstBody.links[0].token).not.toBe(secondBody.links[0].token);
  });

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
  it("inherits canonical link scope from the path and ignores body scope", async () => {
    const owner = await insertCanonicalPersonal("userA");
    const app = buildApp("userA", FULL_CAPS, "active", env.DB, "enabled");
    const response = await app.request(`/${owner.viewIds[1]}/links`, jsonBody({
      label: "课程分享",
      formats: ["ics"],
      personalViewType: "personal_exams",
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    const link = await db.select().from(calendarLinks).where(eq(calendarLinks.id, body.id)).get();
    expect(link?.subscriptionId).toBe(owner.id);
    expect(link?.personalViewType).toBe("personal_courses");
  });

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

  it("accepts one session-scoped personal sync request and ignores body identity", async () => {
    const owner = await insertCanonicalPersonal("userA");
    await env.DB.prepare(`UPDATE subscriptions SET sync_status='success',sync_run_id='old',
      sync_requested_at=NULL,manual_refresh_at=NULL WHERE id=?`)
      .bind(owner.id)
      .run();
    const app = buildApp("userA", FULL_CAPS, "active", env.DB, "enabled");

    const response = await app.request("/personal/syncs", jsonBody({ userId: "userB" }));
    expect(response.status).toBe(202);
    const result = await response.json() as {
      run_id: string;
      affected_subscription_ids: string[];
    };
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.send.mock.calls[0][0].userId).toBe("userA");
    expect(app.send.mock.calls[0][0].subscriptionId).toBe(owner.id);
    expect(result.affected_subscription_ids.sort()).toEqual(owner.viewIds.sort());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues a sync and returns 202", async () => {
    const sid = await insertSub("userA");
    const app = buildSyncApp("userA");
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(202);
    // Manual refreshes carry trigger:"manual" so the consumer bypasses the cron
    // due re-check and always syncs.
    const body = (await res.json()) as { status: string; run_id: string };
    expect(body.status).toBe("queued");
    expect(body.run_id).toEqual(expect.any(String));
    expect(app.send).toHaveBeenCalledWith({
      subscriptionId: sid,
      userId: "userA",
      trigger: "manual",
      runId: body.run_id,
    });
    const state = await env.DB.prepare(
      "SELECT sync_status, sync_run_id, sync_trigger FROM subscriptions WHERE id = ?",
    ).bind(sid).first<{ sync_status: string; sync_run_id: string; sync_trigger: string }>();
    expect(state).toEqual({
      sync_status: "queued",
      sync_run_id: body.run_id,
      sync_trigger: "manual",
    });
  });

  it("returns 404 for another user's subscription (no enqueue)", async () => {
    const sid = await insertSub("userB");
    const app = buildSyncApp("userA");
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(404);
    expect(app.send).not.toHaveBeenCalled();
  });

  it("manual refresh of an external sub → 503 EXTERNAL_UNAVAILABLE (no enqueue)", async () => {
    const sid = await insertSub("userA", {
      sourceType: "instructor",
      sourceId: "T-9",
      sourceName: "李老师",
      isPersonal: false,
    });
    const app = buildSyncApp("userA");
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("EXTERNAL_UNAVAILABLE");
    expect(app.send).not.toHaveBeenCalled();
  });

  it("manual refresh of a still-entitled external sub → 503, row STAYS active (no spurious revoke)", async () => {
    // EXTERNAL_DISABLED freezes the sub, but the owner still HAS the `external`
    // cap — the frozen sub must remain isActive=true so it instantly resumes when
    // the flag flips. The revocation reconcile must NOT fire for an entitled owner.
    const sid = await insertSub("userA", {
      sourceType: "instructor",
      sourceId: "T-7",
      sourceName: "王老师",
      isPersonal: false,
      isActive: true,
    });
    const app = buildSyncApp("userA"); // FULL_CAPS → external granted
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(503);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(true);
  });

  it("manual refresh of a REVOKED external sub (owner lost `external`) → 503 AND reconciles isActive=false", async () => {
    // REVOCATION GAP (Codex round-3): with EXTERNAL_DISABLED=true the manual-refresh
    // route short-circuits with 503 BEFORE the entitlement reconcile. An owner who
    // lost the `external` cap on a frozen external sub would keep serving the public
    // link until the hourly producer catches up. The isActive=false revocation
    // reconcile MUST run before the external soft-disable 503 for an EXISTING sub.
    const sid = await insertSub("userA", {
      sourceType: "instructor",
      sourceId: "T-8",
      sourceName: "赵老师",
      isPersonal: false,
      isActive: true,
    });
    const app = buildSyncApp("userA", capsWith({ external: false })); // owner revoked
    const res = await app.request(`/${sid}/syncs`);
    // Still 503 (external soft-disabled) — never expose WAF — but the link is cut now.
    expect(res.status).toBe(503);
    expect(app.send).not.toHaveBeenCalled();
    // Hard revocation reconciled BEFORE the 503: public calendar route stops serving.
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(false);
  });

  it("manual refresh of a RE-ENTITLED frozen external sub → 503 AND reconciles isActive=true", async () => {
    // REACTIVATION GAP (Codex round-4): the reactivation reconcile (!isActive → set
    // active when the owner REGAINS the cap) ran AFTER the external 503 short-circuit,
    // so a re-entitled frozen external sub stayed inactive until the next cron. Mirror
    // the revocation reorder: reconcile the active/inactive state FULLY before the
    // external unavailable 503. The sub was inactive from an earlier revocation; the
    // owner now HAS `external` again → flip it active NOW, but STILL return 503 (no
    // external sync path — never expose WAF).
    const sid = await insertSub("userA", {
      sourceType: "instructor",
      sourceId: "T-6",
      sourceName: "钱老师",
      isPersonal: false,
      isActive: false, // frozen/revoked earlier
    });
    const app = buildSyncApp("userA"); // FULL_CAPS → external regained
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(503);
    expect(app.send).not.toHaveBeenCalled();
    // Reactivation reconciled BEFORE the 503: link resumes immediately, not next cron.
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(true);
  });

  it("reactivates a previously-revoked sub when the cap is restored", async () => {
    // isActive=false from an earlier revocation; cap now granted → manual refresh
    // should flip it back active immediately (not wait for the hourly cron).
    const sid = await insertSub("userA", { isActive: false });
    const app = buildSyncApp("userA"); // FULL_CAPS → sync granted
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(202);
    expect(app.send).toHaveBeenCalledOnce();
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(true);
  });

  it("revoked sync cap → 403, marks inactive, no enqueue, no quota consumed", async () => {
    const sid = await insertSub("userA"); // personal_all → needs `sync`
    const app = buildSyncApp("userA", capsWith({ sync: false }));
    const res = await app.request(`/${sid}/syncs`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FEATURE_NOT_ENABLED");
    expect(app.send).not.toHaveBeenCalled();
    // Hard revocation: the subscription is flipped inactive (public links 403).
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, sid));
    expect(row.isActive).toBe(false);
    // Quota counter untouched.
    expect(await env.CACHE.get(`refresh:userA:${dayKey()}`)).toBeNull();
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

  it("shares a five-minute manual refresh cooldown across the personal trio", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const allSid = await insertSub("userA", { sourceType: "personal_all", sourceName: "全部" });
    const coursesSid = await insertSub("userA", { sourceType: "personal_courses", sourceName: "课程" });
    const app = buildSyncApp("userA");

    const first = await app.request(`/${allSid}/syncs`);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      affected_subscription_ids: string[];
      cooldown_until: string;
    };
    expect(firstBody.affected_subscription_ids).toEqual(expect.arrayContaining([allSid, coursesSid]));
    expect(firstBody.cooldown_until).toBe("2026-09-06T12:05:00.000Z");

    const second = await app.request(`/${coursesSid}/syncs`);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("300");
    const secondBody = (await second.json()) as {
      detail: { error: { code: string; retry_after_seconds: number } };
    };
    expect(secondBody.detail.error).toMatchObject({
      code: "MANUAL_REFRESH_COOLDOWN",
      retry_after_seconds: 300,
    });
    expect(app.send).toHaveBeenCalledOnce();
  });

  it("allows the personal trio to refresh again after the five-minute cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const allSid = await insertSub("userA", { sourceType: "personal_all", sourceName: "全部" });
    const examsSid = await insertSub("userA", { sourceType: "personal_exams", sourceName: "考试" });
    const app = buildSyncApp("userA");

    expect((await app.request(`/${allSid}/syncs`)).status).toBe(202);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await app.request(`/${examsSid}/syncs`)).status).toBe(202);
    expect(app.send).toHaveBeenCalledTimes(2);
  });

  it("atomically rejects a concurrent second refresh for the personal trio", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const allSid = await insertSub("userA", { sourceType: "personal_all", sourceName: "全部" });
    const coursesSid = await insertSub("userA", { sourceType: "personal_courses", sourceName: "课程" });
    const app = buildSyncApp("userA");

    const responses = await Promise.all([
      app.request(`/${allSid}/syncs`),
      app.request(`/${coursesSid}/syncs`),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([202, 429]);
    expect(app.send).toHaveBeenCalledOnce();
  });

  it("does not start the cooldown when enqueueing fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const sid = await insertSub("userA");
    const app = buildSyncApp("userA");
    app.send.mockRejectedValueOnce(new Error("queue unavailable"));

    const failed = await app.request(`/${sid}/syncs`);
    expect(failed.status).toBe(500);

    const retried = await app.request(`/${sid}/syncs`);
    expect(retried.status).toBe(202);
    expect(app.send).toHaveBeenCalledTimes(2);
  });
});

// ── DB invariant: personal-sub uniqueness regardless of session_id ────────────
//  Personal subs identify by (user, type, source) only — session_id is informational
//  and gets overwritten to the current semester on first sync. SQLite treats NULL as
//  distinct, so the (user,type,source,session) index can't enforce this. A partial
//  unique index over personal source types (any session_id) must (Codex P2).
describe("personal-subscription uniqueness (regardless of session_id)", () => {
  const base = {
    userId: "userU",
    sourceType: "personal_all" as const,
    sourceId: "userU",
    sourceName: "我的课表",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  it("rejects a second identical personal row with null session_id", async () => {
    await db.insert(subscriptions).values({ id: crypto.randomUUID(), ...base, sessionId: null });
    await expect(
      db.insert(subscriptions).values({ id: crypto.randomUUID(), ...base, sessionId: null }),
    ).rejects.toThrow();
  });

  it("rejects a null-session create when an identical row already has a session set", async () => {
    // First row's session was filled by an earlier sync (current semester); a new
    // identical create (session null) must still be rejected — the invariant is
    // "one personal_X per user", independent of session_id.
    await db.insert(subscriptions).values({ id: crypto.randomUUID(), ...base, sessionId: "sess-2024" });
    await expect(
      db.insert(subscriptions).values({ id: crypto.randomUUID(), ...base, sessionId: null }),
    ).rejects.toThrow();
  });
});
