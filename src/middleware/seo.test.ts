import { describe, it, expect } from "vitest";
import { rewriteHtmlMeta } from "./seo";
import { getRouteMeta, BASE_URL } from "../seo";

const TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<title>重庆大学课表订阅 | CQU Schedule</title>
<meta name="description" content="placeholder">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://schedule.cqu.moe/">
<meta property="og:title" content="placeholder">
<meta property="og:description" content="placeholder">
<meta property="og:url" content="https://schedule.cqu.moe/">
<meta name="twitter:title" content="placeholder">
<meta name="twitter:description" content="placeholder">
</head>
<body><div id="app"></div></body>
</html>`;

function makeResponse(html = TEMPLATE_HTML) {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

describe("rewriteHtmlMeta", () => {
  it("sets correct meta for homepage", async () => {
    const result = rewriteHtmlMeta(makeResponse(), "/");
    const html = await result.text();
    const meta = getRouteMeta("/");

    expect(html).toContain(`<title>${meta.title}</title>`);
    expect(html).toContain(`content="${meta.description}"`);
    expect(html).toContain(`href="${BASE_URL}/"`);
    expect(html).not.toContain('content="noindex');
  });

  it("sets correct meta for /api-docs", async () => {
    const result = rewriteHtmlMeta(makeResponse(), "/api-docs");
    const html = await result.text();
    const meta = getRouteMeta("/api-docs");

    expect(html).toContain(`<title>${meta.title}</title>`);
    expect(html).toContain(`content="${meta.description}"`);
    expect(html).toContain(`href="${BASE_URL}/api-docs"`);
    expect(html).not.toContain('content="noindex');
  });

  it("sets noindex with correct title for /login", async () => {
    const result = rewriteHtmlMeta(makeResponse(), "/login");
    const html = await result.text();
    const meta = getRouteMeta("/login");

    expect(html).toContain(`<title>${meta.title}</title>`);
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("sets noindex for unknown routes", async () => {
    const result = rewriteHtmlMeta(makeResponse(), "/dashboard");
    const html = await result.text();

    expect(html).toContain('content="noindex, nofollow"');
  });

  it("passes through non-HTML responses unchanged", async () => {
    const json = new Response('{"ok":true}', {
      headers: { "Content-Type": "application/json" },
    });
    const result = rewriteHtmlMeta(json, "/");
    expect(await result.text()).toBe('{"ok":true}');
  });
});
