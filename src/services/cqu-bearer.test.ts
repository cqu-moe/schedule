import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../types";
import type { AuthService, GetCquTicketResult } from "./auth-rpc";
import { getCquBearer } from "./cqu-bearer";
import * as authModule from "./auth";

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
  return { ...env, AUTH: auth } as unknown as Env;
}

const USER_ID = "user-abc-123";
const BEARER_KEY = `bearer:${USER_ID}`;

beforeEach(async () => {
  await env.CACHE.delete(BEARER_KEY);
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
      clientId: "calendar",
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
