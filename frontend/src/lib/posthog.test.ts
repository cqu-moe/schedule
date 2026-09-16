import { describe, expect, it } from "vitest";
import { sanitizePostHogEvent, templateRoutePath } from "./posthog";

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
