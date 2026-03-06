# OWASP Security Hardening

Based on OWASP Top 10 audit conducted 2026-03-06.

## Scope

Three fixes in one PR, plus a separate issue for token rotation.

### Fix 1: Upgrade axios (A06)

Frontend axios <=1.13.4 has a high-severity DoS vulnerability (GHSA-43fc-jf86-j433, CVSS 7.5).
Upgrade to >=1.13.5.

### Fix 2: Disable `workers_dev` (A05)

`workers_dev: true` exposes the Worker at `*.workers.dev`, bypassing custom domain configuration.
Set to `false` for production.

### Fix 3: Auth failure logging (A09)

Add structured log on invalid token attempts in `src/middleware/auth.ts`.
Include `CF-Connecting-IP` and request path for detecting brute-force attacks.

Log format: `{ event: "auth.invalid_token", ip, path, message: "Invalid token" }`

### Issue only: Token rotation (A07)

Separate GitHub issue for future implementation:
- `POST /api/v1/users/me/rotate-token` endpoint
- Frontend UI entry point
- Regenerates `calendar_token`, invalidates old subscriptions URLs

## Out of scope

- hCaptcha enablement (intentionally deferred)
- `style-src 'unsafe-inline'` in CSP (framework constraint)
- Reversible password encryption (functional requirement for SSO re-login)
