const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://static.cloudflareinsights.com https://*.hcaptcha.com https://hcaptcha.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "frame-src https://*.hcaptcha.com https://hcaptcha.com",
    "connect-src 'self' https://cloudflareinsights.com https://*.hcaptcha.com https://hcaptcha.com",
    "img-src 'self' data:",
  ].join("; "),
};

export function addSecurityHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}
