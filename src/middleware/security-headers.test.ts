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

    // Google Fonts
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
    // hCaptcha
    expect(csp).toContain("https://*.hcaptcha.com");
    expect(csp).toContain("https://hcaptcha.com");
    // Cloudflare Analytics
    expect(csp).toContain("https://static.cloudflareinsights.com");
  });
});
