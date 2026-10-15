import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
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

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

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
function fakeAuth(userId: string, caps: CalendarCaps): AuthService {
  const session: VerifiedSession = {
    user: { id: userId, name: "测试", email: `${userId}@cqu.moe`, role: "user" },
    caps: { calendar: caps },
    cquBindStatus: "active",
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
function buildApp(userId: string, caps: CalendarCaps = FULL_CAPS, overrides: Record<string, unknown> = {}) {
  const app = new Hono<SessionEnv>();
  app.use("*", sessionMiddleware);
  app.route("/", externalV2);
  const testEnv = { ...env, AUTH: fakeAuth(userId, caps), ...overrides };
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


describe("current semester external search", () => {
  it("searches all admin classes without a department and returns trusted semester metadata", async () => {
    const search = vi.fn().mockResolvedValue({
      contractVersion: 1, sourceType: "admin_class", session: { id: "term-26", name: "2026秋" },
      items: [{ id: "class-1", name: "电气测试班", extra: "电气学院 · 2026级" }], truncated: true,
    });
    const app = buildApp("search-global", FULL_CAPS, {
      EXTERNAL_SUBSCRIPTION_TYPES: "admin_class",
      AUTH: { ...fakeAuth("search-global", FULL_CAPS), cquExternalSearch: search },
    });
    const response = await app.request("/search?source_type=admin_class&keyword=电气");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      selection_token: expect.any(String),
      session: { id: "term-26", name: "2026秋" },
      results: [{ id: "class-1", name: "电气测试班", extra: "电气学院 · 2026级" }], truncated: true,
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      userId: "search-global", sourceType: "admin_class", keyword: "电气", departmentId: "", grade: "",
    }));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});


const schoolResult = (name = "当前班级") => ({
  contractVersion: 1, sourceType: "admin_class", session: { id: "current-term", name: "当前学期" },
  items: [{ id: "class-one", name, extra: "区分信息", contact: "must-not-leak" }], truncated: false,
});
function enabledApp(user: string, search: ReturnType<typeof vi.fn>, caps = FULL_CAPS, binding: string | undefined = "active") {
  const auth = fakeAuth(user, caps);
  auth.verifySession = async () => ({ user: { id: user, name: "测试", email: "test@example.com", role: "user" }, caps: { calendar: caps }, cquBindStatus: binding as VerifiedSession["cquBindStatus"] });
  return buildApp(user, caps, { EXTERNAL_SUBSCRIPTION_TYPES: "admin_class", AUTH: { ...auth, cquExternalSearch: search } });
}

async function resetDirectoryTables() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM external_directory_items"),
    env.DB.prepare("DELETE FROM external_directory_course_cache"),
    env.DB.prepare("DELETE FROM external_directory_runs"),
    env.DB.prepare("DELETE FROM external_directory_state"),
    env.DB.prepare("INSERT INTO external_directory_state (id) VALUES (1)"),
  ]);
}

async function seedSharedDirectory() {
  await resetDirectoryTables();
  await env.DB.prepare(`INSERT INTO external_directory_runs
    (id,owner_id,status,phase,started_at,finished_at,session_id,session_name,departments_json,next_attempt_at)
    VALUES ('route-shared','shared-owner','complete',6,0,0,'route-term','当前学期','[]',0)`).run();
  await env.DB.prepare(`UPDATE external_directory_state
    SET catalog_run_id='route-shared',observed_session_id='route-term',observed_at=1`).run();
  await env.DB.prepare(`INSERT INTO external_directory_items (run_id,kind,id,name,extra) VALUES
    ('route-shared','admin_class','percent','%班','百分号字面量'),
    ('route-shared','admin_class','ordinary','普通班','普通')`).run();
}

function directoryApp(user: string, search: ReturnType<typeof vi.fn>, caps = FULL_CAPS) {
  const auth = fakeAuth(user, caps);
  return buildApp(user, caps, {
    EXTERNAL_SUBSCRIPTION_TYPES: "admin_class,course",
    EXTERNAL_DIRECTORY_USER_ID: "shared-owner",
    AUTH: { ...auth, cquExternalSearch: search },
  });
}

describe("external search admission and cache", () => {
  it("isolates cached searches by owner and filters and checks revoked capability before reading", async () => {
    const search = vi.fn().mockResolvedValue(schoolResult());
    const app = enabledApp("cache-a", search);
    const path = "/search?source_type=admin_class&keyword=测试";
    const first = await app.request(path);
    expect(first.status).toBe(200);
    expect(JSON.stringify(await first.json())).not.toContain("must-not-leak");
    expect((await app.request(path)).status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
    expect((await enabledApp("cache-b", search).request(path)).status).toBe(200);
    expect((await app.request(path + "&grade=2025")).status).toBe(200);
    expect(search).toHaveBeenCalledTimes(3);
    expect((await enabledApp("cache-a", search, capsWith({ external: false })).request(path)).status).toBe(403);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("refreshes the trusted term after cache expiry instead of carrying a previous semester", async () => {
    const search = vi.fn().mockResolvedValueOnce(schoolResult()).mockResolvedValueOnce({ ...schoolResult("新学期班级"), session: { id: "next-term", name: "下一学期" } });
    const app = enabledApp("term-expiry", search);
    const path = "/search?source_type=admin_class&keyword=班级";
    expect((await app.request(path)).status).toBe(200);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const response = await app.request(path);
    expect(await response.json()).toMatchObject({ session: { id: "next-term" }, results: [{ name: "新学期班级" }] });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["/search?source_type=student&keyword=测试", 400],
    ["/search?source_type=instructor&keyword=测试", 400],
    ["/search?source_type=admin_class&session_id=old", 400],
    ["/departments?session_id=old", 400],
    ["/search?source_type=admin_class&grade=not-year", 400],
    ["/search?source_type=admin_class&keyword=" + "x".repeat(101), 400],
  ])("rejects unsupported input %s without calling school", async (path, expected) => {
    const search = vi.fn();
    expect((await enabledApp("invalid-input", search).request(path)).status).toBe(expected);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([["unbound", 409], ["revoked", 409], [undefined, 503]])("blocks binding %s before lookup", async (binding, status) => {
    const search = vi.fn();
    const auth = fakeAuth("binding", FULL_CAPS);
    const current = await auth.verifySession("");
    auth.verifySession = async () => ({ ...current!, cquBindStatus: binding as VerifiedSession["cquBindStatus"] });
    const app = buildApp("binding", FULL_CAPS, { EXTERNAL_SUBSCRIPTION_TYPES: "admin_class", AUTH: { ...auth, cquExternalSearch: search } });
    expect((await app.request("/search?source_type=admin_class")).status).toBe(status);
    expect(search).not.toHaveBeenCalled();
  });

  it("resolves a department name from the school directory, not a client-supplied label", async () => {
    const search = vi.fn().mockResolvedValueOnce({ contractVersion: 1, sourceType: "department", session: { id: "current-term", name: "当前学期" }, departments: [{ id: "dept-root", name: "全校", children: [{ id: "dept-1", name: "真实学院" }] }] }).mockResolvedValueOnce(schoolResult());
    const app = enabledApp("department", search);
    expect((await app.request("/search?source_type=admin_class&department_id=dept-1&department_name=伪造学院")).status).toBe(200);
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ departmentId: "dept-1", departmentName: "真实学院" }));
  });

  it.each([
    ["CQU_SESSION_INACTIVE", 409, "CQU_SESSION_INACTIVE"],
    ["TGT_EXPIRED", 409, "CQU_SESSION_INACTIVE"],
    ["SESSION_INACTIVE", 409, "CQU_SESSION_INACTIVE"],
    ["RATE_LIMITED", 503, "EXTERNAL_BUSY"],
    ["PAGE_PERMISSION_DENIED", 403, "EXTERNAL_TARGET_FORBIDDEN"],
    ["BROWSER_BUSY", 503, "EXTERNAL_BUSY"],
    ["SOURCE_FORBIDDEN", 403, "EXTERNAL_TARGET_FORBIDDEN"],
    ["METHOD_NOT_ALLOWED", 503, "EXTERNAL_UNAVAILABLE"],
    ["SECRET cookie abc", 503, "EXTERNAL_UNAVAILABLE"],
  ])("maps upstream %s safely and does not cache a failure", async (upstream, status, code) => {
    const search = vi.fn().mockResolvedValueOnce({ error: upstream }).mockResolvedValueOnce({ ...schoolResult(), items: [] });
    const app = enabledApp(`error-${code}-${status}`, search);
    const path = "/search?source_type=admin_class&keyword=" + encodeURIComponent(upstream);
    const failed = await app.request(path);
    expect(failed.status).toBe(status);
    const body = await failed.json();
    expect(body).toMatchObject({ detail: { error: { code } } });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    const empty = await app.request(path);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ results: [], truncated: false });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed or mismatched school contract instead of showing empty", async () => {
    const search = vi.fn().mockResolvedValue({ ...schoolResult(), sourceType: "department" });
    expect((await enabledApp("schema", search).request("/search?source_type=admin_class")).status).toBe(502);
  });

  it("reports unavailable when the new Auth method is absent", async () => {
    const app = buildApp("old-auth", FULL_CAPS, { EXTERNAL_SUBSCRIPTION_TYPES: "admin_class" });
    expect((await app.request("/search?source_type=admin_class")).status).toBe(503);
  });
});

describe("external directory cache-only route boundary", () => {
  beforeEach(seedSharedDirectory);
  afterEach(resetDirectoryTables);

  it("checks live admission before a shared cache hit", async () => {
    const search = vi.fn();
    const app = directoryApp("cache-denied", search, capsWith({ external: false }));
    const response = await app.request("/search?source_type=admin_class&keyword=%25&lookup=directory");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ detail: { error: { code: "FEATURE_NOT_ENABLED" } } });
    expect(search).not.toHaveBeenCalled();
  });

  it("serves shared hits, returns cache-only misses, and falls back with selection receipts", async () => {
    const userA = `route-cache-a-${crypto.randomUUID()}`;
    const search = vi.fn(async (args: { sourceType: string }) => {
      if (args.sourceType === "admin_class") {
        return { contractVersion: 1, sourceType: "admin_class", session: { id: "route-term", name: "当前学期" }, items: [{ id: "fallback", name: "学校班级", extra: "" }], truncated: false };
      }
      if (args.sourceType === "course_catalog") {
        return { contractVersion: 1, sourceType: "course_catalog", session: { id: "route-term", name: "当前学期" }, items: [{ id: "course-1", name: "大学物理", extra: "PHYS1001" }], truncated: false };
      }
      return { contractVersion: 1, sourceType: "course", course: { id: "course-1", name: "大学物理" }, session: { id: "route-term", name: "当前学期" }, items: [{ id: "class-1", name: "物理01班", extra: "教师甲" }], truncated: false };
    });
    const app = directoryApp(userA, search);

    const shared = await app.request("/search?source_type=admin_class&keyword=%25&lookup=directory");
    expect(shared.status).toBe(200);
    const sharedBody = await shared.json() as { selection_token: string; results: unknown[] };
    expect(sharedBody).toMatchObject({ results: [{ id: "percent", name: "%班" }], selection_token: expect.any(String) });
    expect(search).not.toHaveBeenCalled();

    const miss = await app.request("/search?source_type=admin_class&keyword=不存在&lookup=directory");
    expect(miss.status).toBe(409);
    expect(await miss.json()).toMatchObject({ detail: { error: { code: "EXTERNAL_DIRECTORY_MISS" } } });
    expect(search).not.toHaveBeenCalled();

    const fallback = await app.request("/search?source_type=admin_class&keyword=不存在");
    expect(fallback.status).toBe(200);
    const fallbackBody = await fallback.json() as { selection_token: string };
    expect(fallbackBody.selection_token).not.toBe(sharedBody.selection_token);
    expect(search).toHaveBeenCalledOnce();

    const catalog = await app.request("/search?source_type=course&keyword=物理");
    expect(catalog.status).toBe(200);
    const catalogBody = await catalog.json() as { selection_token: string };
    const classesPath = `/teaching-classes?course_id=course-1&selection_token=${catalogBody.selection_token}`;
    const classes = await app.request(classesPath);
    expect(classes.status).toBe(200);
    const classBody = await classes.json() as { selection_token: string };
    expect(search).toHaveBeenCalledTimes(3);

    const cachedClasses = await app.request(`${classesPath}&lookup=directory`);
    expect(cachedClasses.status).toBe(200);
    const cachedBody = await cachedClasses.json() as { selection_token: string; results: unknown[] };
    expect(cachedBody).toMatchObject({ results: [{ id: "class-1", name: "物理01班" }], selection_token: expect.any(String) });
    expect(cachedBody.selection_token).not.toBe(classBody.selection_token);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("does not expose one user's on-demand course cache to another authenticated user", async () => {
    const userA = `route-course-a-${crypto.randomUUID()}`;
    const userB = `route-course-b-${crypto.randomUUID()}`;
    const searchResult = (classId: string, className: string, sourceType: "course" | "course_catalog") =>
      sourceType === "course_catalog"
        ? { contractVersion: 1, sourceType, session: { id: "route-term", name: "当前学期" }, items: [{ id: "course-1", name: "大学物理", extra: "PHYS1001" }], truncated: false }
        : { contractVersion: 1, sourceType, course: { id: "course-1", name: "大学物理" }, session: { id: "route-term", name: "当前学期" }, items: [{ id: classId, name: className, extra: "" }], truncated: false };
    const searchA = vi.fn(async (args: { sourceType: "course" | "course_catalog" }) => searchResult("class-a", "用户A班级", args.sourceType));
    const searchB = vi.fn(async (args: { sourceType: "course" | "course_catalog" }) => searchResult("class-b", "用户B班级", args.sourceType));
    const appA = directoryApp(userA, searchA);
    const appB = directoryApp(userB, searchB);

    const catalogA = await appA.request("/search?source_type=course&keyword=物理");
    const tokenA = ((await catalogA.json()) as { selection_token: string }).selection_token;
    expect((await appA.request(`/teaching-classes?course_id=course-1&selection_token=${tokenA}`)).status).toBe(200);
    expect(searchA).toHaveBeenCalledTimes(2);

    const catalogB = await appB.request("/search?source_type=course&keyword=物理");
    const tokenB = ((await catalogB.json()) as { selection_token: string }).selection_token;
    const miss = await appB.request(`/teaching-classes?course_id=course-1&selection_token=${tokenB}&lookup=directory`);
    expect(miss.status).toBe(409);
    expect(await miss.json()).toMatchObject({ detail: { error: { code: "EXTERNAL_DIRECTORY_MISS" } } });
    expect(searchB).toHaveBeenCalledOnce();

    const fallback = await appB.request(`/teaching-classes?course_id=course-1&selection_token=${tokenB}`);
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ results: [{ id: "class-b", name: "用户B班级" }] });
    expect(searchB).toHaveBeenCalledTimes(2);
    const cached = await appB.request(`/teaching-classes?course_id=course-1&selection_token=${tokenB}&lookup=directory`);
    expect(await cached.json()).toMatchObject({ results: [{ id: "class-b", name: "用户B班级" }] });
    expect(searchB).toHaveBeenCalledTimes(2);
  });
});

it.each(["admin_class", "instructor", "room", "laboratory", "course"])("pilot gate denies %s search before school access and admits the selected user", async sourceType => {
  const userId = "fixture-search-pilot";
  const search = vi.fn().mockResolvedValue({ ...schoolResult(), sourceType: sourceType === "course" ? "course_catalog" : sourceType });
  const enabled = { EXTERNAL_SUBSCRIPTION_TYPES: sourceType, AUTH: { ...fakeAuth(userId, FULL_CAPS), cquExternalSearch: search } };
  for (const pilots of ["fixture-other", "", "   "]) {
    const denied = buildApp(userId, FULL_CAPS, { ...enabled, EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS: pilots });
    for (const path of [`/search?source_type=${sourceType}&keyword=测试`, "/departments", "/teaching-classes?course_id=fixture&selection_token=fixture"]) {
      const response = await denied.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ detail: { error: { code: "EXTERNAL_UNAVAILABLE" } } });
    }
  }
  expect(search).not.toHaveBeenCalled();
  const admitted = buildApp(userId, FULL_CAPS, { ...enabled, EXTERNAL_SUBSCRIPTION_PILOT_USER_IDS: ` ${userId},fixture-other ` });
  expect((await admitted.request(`/search?source_type=${sourceType}&keyword=测试`)).status).toBe(200);
  expect(search).toHaveBeenCalledOnce();
});
