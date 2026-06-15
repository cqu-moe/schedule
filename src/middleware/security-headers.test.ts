import { describe, it, expect } from "vitest";
import { addSecurityHeaders } from "./security-headers";

describe("addSecurityHeaders", () => {
  it("adds all security headers to response", () => {
    const original = new Response("hello", { status: 200 });
    const result = addSecurityHeaders(original);

    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
    expect(result.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(result.headers.get("Permissions-Policy")).toBe("geolocation=(), microphone=(), camera=()");
    expect(result.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("preserves original response body and status", async () => {
    const original = new Response('{"ok":true}', {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
    const result = addSecurityHeaders(original);

    expect(result.status).toBe(201);
    expect(result.headers.get("Content-Type")).toBe("application/json");
    expect(await result.text()).toBe('{"ok":true}');
  });

  it("CSP allows required external resources", () => {
    const result = addSecurityHeaders(new Response(""));
    const csp = result.headers.get("Content-Security-Policy")!;

    // Cloudflare Analytics
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("https://cloudflareinsights.com");
    // font data: URLs (FullCalendar fcicons)
    expect(csp).toContain("font-src 'self' data:");
  });

  it("CSP no longer references hCaptcha (captcha removed in v2)", () => {
    const csp = addSecurityHeaders(new Response("")).headers.get("Content-Security-Policy")!;
    expect(csp).not.toContain("hcaptcha");
  });
});
