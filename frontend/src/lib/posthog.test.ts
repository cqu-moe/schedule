import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizePostHogEvent, templateRoutePath } from "./posthog";

async function loadTelemetry(persistedUserId: string | undefined) {
  vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "test");
  const posthog = {
    init: vi.fn(),
    register: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    get_property: (name: string) => (name === "$user_id" ? persistedUserId : undefined),
  };
  vi.doMock("posthog-js", () => ({ default: posthog }));
  vi.resetModules();
  const telemetry = await import("./posthog");
  telemetry.initPostHog();
  return { telemetry, posthog };
}

describe("Schedule browser PostHog privacy boundary", () => {
  it("templates share-link paths and removes query and hash data", () => {
    expect(templateRoutePath("/view/secret-subscription-token")).toBe("/view/:token");
    const event = sanitizePostHogEvent({
      event: "$pageview",
      properties: {
        $current_url: "https://schedule.cqu.moe/view/secret-subscription-token?code=secret#calendar",
        email: "user@example.com",
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("secret-subscription-token");
    expect(serialized).not.toContain("user@example.com");
    expect(event?.properties.$current_url).toBe("https://schedule.cqu.moe/view/:token");
  });
});

describe("Schedule browser PostHog identity sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("posthog-js");
  });

  it("resets a persisted other-account identity before identifying, but keeps anonymous continuity", async () => {
    const stale = await loadTelemetry("user-a");
    stale.telemetry.syncPostHogIdentity("user-b");
    expect(stale.posthog.reset).toHaveBeenCalledTimes(1);
    expect(stale.posthog.identify).toHaveBeenCalledWith("user-b");

    const anonymous = await loadTelemetry(undefined);
    anonymous.telemetry.syncPostHogIdentity("user-c");
    expect(anonymous.posthog.reset).not.toHaveBeenCalled();
    expect(anonymous.posthog.identify).toHaveBeenCalledWith("user-c");

    const sameUser = await loadTelemetry("user-c");
    sameUser.telemetry.syncPostHogIdentity("user-c");
    expect(sameUser.posthog.reset).not.toHaveBeenCalled();

    const loggedOut = await loadTelemetry("user-a");
    loggedOut.telemetry.syncPostHogIdentity(null);
    expect(loggedOut.posthog.reset).toHaveBeenCalledTimes(1);
    expect(loggedOut.posthog.identify).not.toHaveBeenCalled();
  });
});
