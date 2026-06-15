import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../types";
import type { AuthService, GetCquTicketResult } from "./auth-rpc";
import { getCquBearer, resolveOwnStudentId, invalidateCquBearer } from "./cqu-bearer";
import * as authModule from "./auth";

/** Build a fake CQU bearer JWT carrying the given `user_name` (学号) claim. */
function fakeBearer(userName: string): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url({ user_name: userName })}.sig`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake AUTH binding whose getCquTicket returns the given result. */
function fakeAuth(result: GetCquTicketResult): AuthService {
  return {
    async verifySession() {
      return null;
    },
    async getCquTicket() {
      return result;
    },
  };
}

/** Build a test Env with a real KV (from cloudflare:test) + the given AUTH. */
function buildEnv(auth: AuthService): Env {
  return {
    ...env,
    AUTH: auth,
    CALENDAR_CLIENT_ID: "test-client-id",
    CALENDAR_CLIENT_SECRET: "test-secret",
  } as unknown as Env;
}

const USER_ID = "user-abc-123";
const BEARER_KEY = `bearer:${USER_ID}`;
const STUDENT_KEY = `student:${USER_ID}`;

beforeEach(async () => {
  await env.CACHE.delete(BEARER_KEY);
  await env.CACHE.delete(STUDENT_KEY);
  vi.restoreAllMocks();
});

describe("getCquBearer", () => {
  it("returns cached bearer when KV hit (no ticket exchange)", async () => {
    await env.CACHE.put(BEARER_KEY, "cached-bearer");
    const getTicketSpy = vi.fn();
    const auth = fakeAuth({ ticket: "should-not-be-used" });
    auth.getCquTicket = getTicketSpy;

    const bearer = await getCquBearer(buildEnv(auth), USER_ID);

    expect(bearer).toBe("cached-bearer");
    expect(getTicketSpy).not.toHaveBeenCalled();
  });

  it("on KV miss: gets ticket, exchanges for bearer, caches it", async () => {
    const exchangeSpy = vi
      .spyOn(authModule, "exchangeTicketForCquToken")
      .mockResolvedValue({
        accessToken: "fresh-bearer",
        refreshToken: "r",
        expiresAt: new Date().toISOString(),
      });
    const auth = fakeAuth({ ticket: "ST-xyz" });

    const bearer = await getCquBearer(buildEnv(auth), USER_ID);

    expect(bearer).toBe("fresh-bearer");
    expect(exchangeSpy).toHaveBeenCalledWith("ST-xyz");
    // Bearer cached in KV for subsequent calls.
    expect(await env.CACHE.get(BEARER_KEY)).toBe("fresh-bearer");
  });

  it("calls getCquTicket with the calendar/jwxt client args", async () => {
    vi.spyOn(authModule, "exchangeTicketForCquToken").mockResolvedValue({
      accessToken: "b",
      refreshToken: "",
      expiresAt: new Date().toISOString(),
    });
    const getTicketSpy = vi.fn().mockResolvedValue({ ticket: "ST" });
    const auth = fakeAuth({ ticket: "ST" });
    auth.getCquTicket = getTicketSpy;

    await getCquBearer(buildEnv(auth), USER_ID);

    expect(getTicketSpy).toHaveBeenCalledWith({
      clientId: "test-client-id",
      clientSecret: "test-secret",
      service: "jwxt",
      userId: USER_ID,
    });
  });

  it("returns null when getCquTicket returns an error (no throw)", async () => {
    const exchangeSpy = vi.spyOn(authModule, "exchangeTicketForCquToken");
    const auth = fakeAuth({ error: "SESSION_INACTIVE" });

    const bearer = await getCquBearer(buildEnv(auth), USER_ID);

    expect(bearer).toBeNull();
    expect(exchangeSpy).not.toHaveBeenCalled();
  });

  it("returns null when the ticket exchange throws (no throw)", async () => {
    vi.spyOn(authModule, "exchangeTicketForCquToken").mockRejectedValue(
      new Error("UPSTREAM_UNREACHABLE"),
    );
    const auth = fakeAuth({ ticket: "ST" });

    const bearer = await getCquBearer(buildEnv(auth), USER_ID);

    expect(bearer).toBeNull();
  });
});

describe("invalidateCquBearer", () => {
  it("deletes the cached bearer so the next call re-mints", async () => {
    await env.CACHE.put(BEARER_KEY, "stale-bearer");
    await invalidateCquBearer(buildEnv(fakeAuth({ error: "X" })), USER_ID);
    expect(await env.CACHE.get(BEARER_KEY)).toBeNull();
  });
});

describe("resolveOwnStudentId", () => {
  const auth = fakeAuth({ error: "NOT_USED" });

  it("decodes the 学号 from the current bearer", async () => {
    const studentId = await resolveOwnStudentId(fakeBearer("20210001"), USER_ID);
    expect(studentId).toBe("20210001");
  });

  it("SECURITY: always reflects the current bearer, never a stale cached 学号", async () => {
    // Simulate a stale cache from a previous CQU binding. After rebinding, the
    // bearer subject changes; resolveOwnStudentId MUST return the new bearer's
    // 学号, not the old cached one — otherwise sync could leak another student.
    await env.CACHE.put(STUDENT_KEY, "20259999");
    const studentId = await resolveOwnStudentId(fakeBearer("20210001"), USER_ID);
    expect(studentId).toBe("20210001");
  });

  it("returns null (no throw) when the bearer carries no student ID", async () => {
    const studentId = await resolveOwnStudentId("opaque-token", USER_ID);
    expect(studentId).toBeNull();
  });
});
