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
    capture: vi.fn(),
    captureException: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
  };
  vi.doMock("posthog-js", () => ({ default: posthog }));
  vi.resetModules();
  const telemetry = await import("./posthog");
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
    await stale.telemetry.initPostHog();
    stale.telemetry.syncPostHogIdentity("user-b");
    expect(stale.posthog.reset).toHaveBeenCalledTimes(1);
    expect(stale.posthog.identify).toHaveBeenCalledWith("user-b");

    const anonymous = await loadTelemetry(undefined);
    await anonymous.telemetry.initPostHog();
    anonymous.telemetry.syncPostHogIdentity("user-c");
    expect(anonymous.posthog.reset).not.toHaveBeenCalled();
    expect(anonymous.posthog.identify).toHaveBeenCalledWith("user-c");

    const sameUser = await loadTelemetry("user-c");
    await sameUser.telemetry.initPostHog();
    sameUser.telemetry.syncPostHogIdentity("user-c");
    expect(sameUser.posthog.reset).not.toHaveBeenCalled();

    const loggedOut = await loadTelemetry("user-a");
    await loggedOut.telemetry.initPostHog();
    loggedOut.telemetry.syncPostHogIdentity(null);
    expect(loggedOut.posthog.reset).toHaveBeenCalledTimes(1);
    expect(loggedOut.posthog.identify).not.toHaveBeenCalled();
  });
});

describe("Schedule browser PostHog deferred lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("posthog-js");
  });

  it("does not import the SDK without a project token", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
    const init = vi.fn();
    const loadSdk = vi.fn(() => ({ default: { init } }));
    vi.doMock("posthog-js", loadSdk);
    vi.resetModules();
    const telemetry = await import("./posthog");

    await expect(telemetry.initPostHog()).resolves.toBe(false);
    expect(loadSdk).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  it("applies the latest identity, pageview, and replay route after the SDK loads", async () => {
    const { telemetry, posthog } = await loadTelemetry("user-a");
    const ready = telemetry.initPostHog();

    telemetry.syncPostHogIdentity("user-b");
    telemetry.syncPostHogIdentity("user-c");
    telemetry.captureSchedulePageview("/view/secret-subscription-token");
    telemetry.captureSchedulePageview("/dashboard");
    telemetry.syncPostHogReplay("/");
    telemetry.syncPostHogReplay("/view/secret-subscription-token");
    await ready;

    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(posthog.identify).toHaveBeenCalledTimes(1);
    expect(posthog.identify).toHaveBeenCalledWith("user-c");
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: expect.stringContaining("/dashboard"),
      route: "/dashboard",
    });
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("treats the removed changelog page as private for session recording", async () => {
    const { telemetry, posthog } = await loadTelemetry(undefined);
    await telemetry.initPostHog();

    telemetry.syncPostHogReplay("/api-docs");
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);

    telemetry.syncPostHogReplay("/changelog");
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("keeps the app usable when the SDK import fails", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "test");
    vi.doMock("posthog-js", () => {
      throw new Error("SDK chunk unavailable");
    });
    vi.resetModules();
    const telemetry = await import("./posthog");

    await expect(telemetry.initPostHog()).resolves.toBe(false);
    telemetry.syncPostHogIdentity("user-a");
    telemetry.captureSchedulePageview("/");
    telemetry.syncPostHogReplay("/");
    telemetry.captureScheduleException(new Error("render failed"));
  });
});
