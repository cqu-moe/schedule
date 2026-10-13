import { afterEach, describe, expect, it, vi } from "vitest";

describe("Schedule browser PostHog persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses localStorage only and removes the legacy PostHog cookie", async () => {
    vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "test");
    vi.stubEnv("VITE_POSTHOG_ALLOW_NON_PRODUCTION", "true");
    const init = vi.fn();
    vi.doMock("posthog-js", () => ({
      default: {
        init,
        register: vi.fn(),
      },
    }));
    document.cookie = "ph_test_posthog=legacy; Path=/";
    const telemetry = await import("./posthog");

    await expect(telemetry.initPostHog()).resolves.toBe(true);
    expect(init).toHaveBeenCalledWith("test", expect.objectContaining({
      api_host: "https://p.cqu.moe",
      asset_host: "https://p.cqu.moe",
      ui_host: "https://us.posthog.com",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      save_referrer: false,
      save_campaign_params: false,
      autocapture: false,
      capture_performance: false,
      capture_dead_clicks: false,
      disable_scroll_properties: true,
      advanced_disable_feature_flags: true,
      disable_surveys: true,
      disable_web_experiments: true,
      disable_product_tours: true,
      disable_conversations: true,
      advanced_disable_toolbar_metrics: true,
      opt_in_site_apps: false,
      capture_heatmaps: false,
      disable_session_recording: true,
      session_recording: expect.objectContaining({
        sampleRate: 1,
        maskAllInputs: true,
        maskTextSelector: "*",
        blockSelector: expect.stringContaining("[data-sensitive]"),
        recordHeaders: false,
        recordBody: false,
      }),
    }));
    expect(document.cookie).not.toContain("ph_test_posthog");
  });
});
