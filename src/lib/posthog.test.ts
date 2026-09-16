import { describe, expect, it } from "vitest";
import { sanitizePostHogProperties } from "./posthog";

describe("Schedule Worker PostHog privacy boundary", () => {
  it("redacts tokens, schedule data, and URL query values", () => {
    const properties = sanitizePostHogProperties({
      service: "schedule-worker",
      subscription_url: "https://schedule.cqu.moe/ics/secret-link",
      token: "secret-token",
      schedule: [{ title: "private class" }],
      email: "user@example.com",
      url: "https://schedule.cqu.moe/view/secret-token?code=secret-code",
      error_code: "SAFE_ERROR",
    });

    const serialized = JSON.stringify(properties);
    for (const secret of ["secret-link", "secret-token", "private class", "user@example.com", "secret-code"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(properties).toMatchObject({
      service: "schedule-worker",
      error_code: "SAFE_ERROR",
      subscription_url: "[redacted]",
    });
  });
});
