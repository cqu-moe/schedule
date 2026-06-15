import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session";
import type {
  AuthService,
  CalendarCaps,
  VerifiedSession,
} from "../../services/auth-rpc";
import * as bearerModule from "../../services/cqu-bearer";
import { CQUAPIClient } from "../../services/cqu-api";
import type { SearchResult, DepartmentNode } from "../../services/cqu-api";
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

// ── GET /search ──────────────────────────────────────────────────────────────

describe("GET /api/v2/external/search", () => {
  it("without `external` cap → 403 FEATURE_NOT_ENABLED", async () => {
    const app = buildApp("userA", capsWith({ external: false }));
    const res = await app.request("/search?source_type=instructor&keyword=张");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FEATURE_NOT_ENABLED");
  });

  it("missing keyword → 400 BAD_REQUEST", async () => {
    const app = buildApp("userA");
    const res = await app.request("/search?source_type=instructor");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("BAD_REQUEST");
  });

  it("empty/whitespace keyword → 400 BAD_REQUEST", async () => {
    const app = buildApp("userA");
    const res = await app.request("/search?source_type=instructor&keyword=%20%20");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("BAD_REQUEST");
  });

  it("over-long keyword (>100) → 400 BAD_REQUEST", async () => {
    const app = buildApp("userA");
    const res = await app.request(
      `/search?source_type=instructor&keyword=${"x".repeat(101)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("BAD_REQUEST");
  });

  it("getCquBearer null → 409 CQU_SESSION_INACTIVE", async () => {
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue(null);
    const app = buildApp("userA");
    const res = await app.request("/search?source_type=instructor&keyword=张");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("CQU_SESSION_INACTIVE");
  });

  it("instructor search → 200 { results }", async () => {
    const fixture: SearchResult[] = [
      { id: "T-1", name: "张老师", extra: "数学学院 / 0001" },
    ];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const spy = vi
      .spyOn(CQUAPIClient.prototype, "searchInstructor")
      .mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request("/search?source_type=instructor&keyword=张");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results).toEqual(fixture);
    expect(spy).toHaveBeenCalledWith("张");
  });

  it("room search → 200 { results }", async () => {
    const fixture: SearchResult[] = [{ id: "R-1", name: "DS1417", extra: "容量: 60" }];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const spy = vi.spyOn(CQUAPIClient.prototype, "searchRoom").mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request("/search?source_type=room&keyword=DS14");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results).toEqual(fixture);
    expect(spy).toHaveBeenCalledWith("DS14");
  });

  it("laboratory search → 200 { results }", async () => {
    const fixture: SearchResult[] = [{ id: "L-1", name: "物理实验室", extra: "A / B" }];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const spy = vi
      .spyOn(CQUAPIClient.prototype, "searchLaboratory")
      .mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request("/search?source_type=laboratory&keyword=物理");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results).toEqual(fixture);
    expect(spy).toHaveBeenCalledWith("物理");
  });

  it("course search with explicit session_id → uses it (no getSessionList call)", async () => {
    const fixture: SearchResult[] = [{ id: "C-1", name: "高数 (0001)", extra: "" }];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const searchCourse = vi
      .spyOn(CQUAPIClient.prototype, "searchCourse")
      .mockResolvedValue(fixture);
    const getSessionList = vi.spyOn(CQUAPIClient.prototype, "getSessionList");

    const app = buildApp("userA");
    const res = await app.request(
      "/search?source_type=course&keyword=高数&session_id=sess-9",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results).toEqual(fixture);
    expect(searchCourse).toHaveBeenCalledWith("高数", "sess-9");
    expect(getSessionList).not.toHaveBeenCalled();
  });

  it("course search without session_id → resolves current session via getSessionList", async () => {
    const fixture: SearchResult[] = [{ id: "C-2", name: "线代 (0002)", extra: "" }];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    vi.spyOn(CQUAPIClient.prototype, "getSessionList").mockResolvedValue({
      current_session_id: "sess-current",
      sessions: {},
    });
    const searchCourse = vi
      .spyOn(CQUAPIClient.prototype, "searchCourse")
      .mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request("/search?source_type=course&keyword=线代");
    expect(res.status).toBe(200);
    expect(searchCourse).toHaveBeenCalledWith("线代", "sess-current");
  });

  it("admin_class search → passes department_id, grade, keyword(=className)", async () => {
    const fixture: SearchResult[] = [{ id: "AC-1", name: "软件1班", extra: "2021级 / 30人" }];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const searchAdminClass = vi
      .spyOn(CQUAPIClient.prototype, "searchAdminClass")
      .mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request(
      "/search?source_type=admin_class&keyword=软件&department_id=D-7&grade=2021",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results).toEqual(fixture);
    expect(searchAdminClass).toHaveBeenCalledWith("D-7", "2021", "软件");
  });

  it("admin_class search with blank keyword + department_id → 200 (browse whole department)", async () => {
    // The frontend treats the class keyword as optional and fires a search right
    // after a department is picked; an empty keyword must browse all classes.
    const fixture: SearchResult[] = [{ id: "AC-9", name: "软件1班", extra: "2021级 / 30人" }];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const searchAdminClass = vi
      .spyOn(CQUAPIClient.prototype, "searchAdminClass")
      .mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request(
      "/search?source_type=admin_class&department_id=D-7&grade=2021",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: SearchResult[] };
    expect(body.results).toEqual(fixture);
    expect(searchAdminClass).toHaveBeenCalledWith("D-7", "2021", "");
  });

  it("admin_class search without department_id → 400 BAD_REQUEST (no searchAdminClass call)", async () => {
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const searchAdminClass = vi.spyOn(CQUAPIClient.prototype, "searchAdminClass");

    const app = buildApp("userA");
    const res = await app.request("/search?source_type=admin_class&keyword=软件&grade=2021");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("BAD_REQUEST");
    expect(searchAdminClass).not.toHaveBeenCalled();
  });

  it("unknown source_type → 400 BAD_REQUEST", async () => {
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const app = buildApp("userA");
    const res = await app.request("/search?source_type=bogus&keyword=x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("BAD_REQUEST");
  });

  it("CQU upstream error (401) → 401 TOKEN_EXPIRED", async () => {
    const { CQUAPIError } = await import("../../services/cqu-api");
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    vi.spyOn(CQUAPIClient.prototype, "searchInstructor").mockRejectedValue(
      new CQUAPIError("Access Token 无效或已过期", 401),
    );

    const app = buildApp("userA");
    const res = await app.request("/search?source_type=instructor&keyword=张");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("TOKEN_EXPIRED");
  });
});

// ── GET /departments ─────────────────────────────────────────────────────────

describe("GET /api/v2/external/departments", () => {
  it("without `external` cap → 403 FEATURE_NOT_ENABLED", async () => {
    const app = buildApp("userA", capsWith({ external: false }));
    const res = await app.request("/departments");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("FEATURE_NOT_ENABLED");
  });

  it("getCquBearer null → 409 CQU_SESSION_INACTIVE", async () => {
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue(null);
    const app = buildApp("userA");
    const res = await app.request("/departments");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: { error: { code: string } } };
    expect(body.detail.error.code).toBe("CQU_SESSION_INACTIVE");
  });

  it("happy path → 200 { departments }", async () => {
    const fixture: DepartmentNode[] = [
      { id: "D-1", name: "计算机学院", children: [{ id: "D-1-1", name: "软件工程系" }] },
    ];
    vi.spyOn(bearerModule, "getCquBearer").mockResolvedValue("test-bearer");
    const spy = vi
      .spyOn(CQUAPIClient.prototype, "getDepartments")
      .mockResolvedValue(fixture);

    const app = buildApp("userA");
    const res = await app.request("/departments");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { departments: DepartmentNode[] };
    expect(body.departments).toEqual(fixture);
    expect(spy).toHaveBeenCalledOnce();
  });
});
