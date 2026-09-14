import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { subscriptions, calendarLinks, LINK_FORMATS } from "../../db/schema";
import type { Env } from "../../types";
import calendarV2 from "./calendar";

const db = drizzle(env.DB);

// ── App under test (public, no sessionMiddleware) ────────────────────────────
//
// The public endpoints are wrapped in `rateLimit("UNAUTH_LIMITER")`, a REAL
// limiter binding from `cloudflare:test` keyed on the `CF-Connecting-IP` header
// (limit 5 / 60s). With no header every request shares the "unknown" bucket and
// the suite trips 429 after the 5th call. Give each request a unique IP so each
// gets its own bucket and the limiter never interferes with assertions.

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 254}.${ipCounter}`;
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", calendarV2);
  return {
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("CF-Connecting-IP", uniqueIp());
      return app.request(path, { ...init, headers }, env);
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COURSES = [
  {
    name: "高等数学",
    lecturer: "张老师",
    room: "DS1417",
    position: "",
    day_of_week: 1,
    start_session: 1,
    end_session: 2,
    weeks: [1, 2, 3],
  },
];

const EXAMS = [
  {
    name: "高等数学期末",
    room: "DS1417",
    seat: 12,
    start_time: "2025-01-10T08:00:00.000Z",
    end_time: "2025-01-10T10:00:00.000Z",
  },
];

const SAMPLE_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";

/** Insert a subscription row directly. */
async function insertSub(
  overrides: Partial<typeof subscriptions.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(subscriptions).values({
    id,
    userId: "userA",
    sourceType: "personal_all",
    sourceId: "20210001",
    sourceName: "我的课表",
    sessionName: "2024-2025学年第一学期",
    semesterStart: "2024-09-02",
    icsContent: SAMPLE_ICS,
    coursesJson: JSON.stringify(COURSES),
    examsJson: JSON.stringify(EXAMS),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

/** Insert a calendar_links row directly; returns its token. */
async function insertLink(
  subscriptionId: string,
  formats: string[],
  overrides: Partial<typeof calendarLinks.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  const token = (overrides.token as string) ?? `tok-${id}`;
  const now = new Date().toISOString();
  await db.insert(calendarLinks).values({
    id,
    subscriptionId,
    token,
    formats: JSON.stringify(formats),
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return token;
}

// ── Schema setup (mirrors subscriptions.test.ts) ─────────────────────────────

beforeAll(async () => {
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
      is_active integer NOT NULL DEFAULT 1,
      ics_content text,
      courses_json text,
      exams_json text,
      last_synced_at text,
      sync_status text NOT NULL DEFAULT 'idle', sync_run_id text, sync_trigger text,
      sync_requested_at text, sync_started_at text, sync_finished_at text,
      sync_error_code text, sync_error_message text,
      manual_refresh_at text,
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
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM subscriptions").run();
});

// ── Default (all-format) link: every endpoint reachable ──────────────────────

describe("default (all-format) link", () => {
  it("uses the stored personal view scope for every public format", async () => {
    const sid = await insertSub({
      sourceType: "personal",
      sourceId: "userA",
      isPersonal: true,
    });
    const token = await insertLink(sid, [...LINK_FORMATS], {
      personalViewType: "personal_courses",
    });
    for (const path of ["calendar.ics", "origin.json", "data.json", "data.csv", "view.json"]) {
      const response = await buildApp().request(`/${token}/${path}?view=personal_all`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("高等数学");
      expect(body).not.toContain("高等数学期末");
    }
  });

  it("GET /:token/calendar.ics → 200 ICS with correct headers", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, [...LINK_FORMATS], {
      token: "default",
      isDefault: true,
    });

    const res = await buildApp().request(`/${token}/calendar.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="schedule.ics"',
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await res.text()).toBe(SAMPLE_ICS);
  });

  it("GET /:token/calendar.ics → 403 when the subscription is inactive (revoked)", async () => {
    const sid = await insertSub({ isActive: false });
    const token = await insertLink(sid, [...LINK_FORMATS], {
      token: "inactive-ics",
      isDefault: true,
    });
    const res = await buildApp().request(`/${token}/calendar.ics`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("GET /:token/calendar.ics → EMPTY_ICS when icsContent is null", async () => {
    const sid = await insertSub({ icsContent: null });
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "empty" });

    const res = await buildApp().request(`/${token}/calendar.ics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("END:VCALENDAR");
  });

  it("GET /:token/origin.json → 200 raw courses + exams", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "origin" });

    const res = await buildApp().request(`/${token}/origin.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="origin.json"',
    );
    const body = (await res.json()) as { courses: unknown[]; exams: unknown[] };
    expect(body.courses).toEqual(COURSES);
    expect(body.exams).toEqual(EXAMS);
  });

  it("GET /:token/data.json → 200 formatted events + metadata", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "data" });

    const res = await buildApp().request(`/${token}/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="data.json"',
    );
    const body = (await res.json()) as {
      semester: string;
      semester_start: string;
      generated_at: string;
      events: { name: string; type: string }[];
    };
    expect(body.semester).toBe("2024秋");
    expect(body.semester_start).toBe("2024-09-02");
    expect(typeof body.generated_at).toBe("string");
    // 3 course occurrences + 1 exam = 4 events.
    expect(body.events.length).toBe(4);
    expect(body.events.some((e) => e.type === "exam")).toBe(true);
  });

  it("GET /:token/data.csv → 200 CSV", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "csv" });

    const res = await buildApp().request(`/${token}/data.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="schedule.csv"',
    );
    const text = await res.text();
    expect(text).toContain("name,type,instructor");
    expect(text).toContain("高等数学");
  });

  it("GET /:token/view.json → 200 events (no attachment header)", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "view" });

    const res = await buildApp().request(`/${token}/view.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    const body = (await res.json()) as {
      semester: string;
      events: { name: string }[];
    };
    expect(body.semester).toBe("2024秋");
    expect(body.events.length).toBe(4);
  });
});

// ── Format gating ────────────────────────────────────────────────────────────

describe("format gating", () => {
  it("web-only link: GET /:token/calendar.ics → 403 FORMAT_NOT_ALLOWED", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, ["web"], { token: "webonly" });

    const res = await buildApp().request(`/${token}/calendar.ics`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FORMAT_NOT_ALLOWED");
  });

  it("web-only link: GET /:token/view.json → 200", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, ["web"], { token: "webonly2" });

    const res = await buildApp().request(`/${token}/view.json`);
    expect(res.status).toBe(200);
  });

  it("ics-only link: data.json/csv/origin.json/view.json all → 403", async () => {
    const sid = await insertSub();
    const token = await insertLink(sid, ["ics"], { token: "icsonly" });
    const app = buildApp();

    for (const path of ["origin.json", "data.json", "data.csv", "view.json"]) {
      const res = await app.request(`/${token}/${path}`);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { detail: { error: { code: string } } };
      expect(body.detail.error.code).toBe("FORMAT_NOT_ALLOWED");
    }
    // ics itself is allowed.
    const ics = await app.request(`/${token}/calendar.ics`);
    expect(ics.status).toBe(200);
  });
});

// ── Unknown token → 404 (uniform, no enumeration) ────────────────────────────

describe("unknown token", () => {
  it("each endpoint → 404 for an unknown token", async () => {
    const app = buildApp();
    for (const path of [
      "calendar.ics",
      "origin.json",
      "data.json",
      "data.csv",
      "view.json",
    ]) {
      const res = await app.request(`/no-such-token/${path}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail: { error: { code: string } } };
      expect(body.detail.error.code).toBe("NOT_FOUND");
    }
  });
});

// ── Corrupted stored JSON → 500 DATA_CORRUPTED ───────────────────────────────

describe("corrupted JSON", () => {
  it("data.json with bad coursesJson → 500 DATA_CORRUPTED", async () => {
    const sid = await insertSub({ coursesJson: "not json{{{" });
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "bad" });

    const res = await buildApp().request(`/${token}/data.json`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("DATA_CORRUPTED");
  });

  it("origin.json with bad examsJson → 500 DATA_CORRUPTED", async () => {
    const sid = await insertSub({ examsJson: "}}}bad" });
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "bad2" });

    const res = await buildApp().request(`/${token}/origin.json`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("DATA_CORRUPTED");
  });

  it("csv with bad coursesJson → 500 DATA_CORRUPTED", async () => {
    const sid = await insertSub({ coursesJson: "[oops" });
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "bad3" });

    const res = await buildApp().request(`/${token}/data.csv`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("DATA_CORRUPTED");
  });

  it("view.json with bad coursesJson → 500 DATA_CORRUPTED", async () => {
    const sid = await insertSub({ coursesJson: "x" });
    const token = await insertLink(sid, [...LINK_FORMATS], { token: "bad4" });

    const res = await buildApp().request(`/${token}/view.json`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("DATA_CORRUPTED");
  });
});
