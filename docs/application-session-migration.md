# Schedule independent browser session

Schedule now completes OAuth/OIDC in its existing backend. The browser receives
only a random `__Host-schedule_session` cookie: Secure, HttpOnly, SameSite=Lax,
Path=/ and no Domain. It no longer forwards central Auth cookies to verifySession.
The existing production callback remains `https://schedule.cqu.moe/callback`.

## Required configuration before enabling the consumer

Apply D1 migration `0016_application_sessions.sql`. This adds only local login
transactions and browser sessions to the existing Schedule DB. Do not remove
CACHE: background synchronization still uses its existing cache contract.

Use existing CALENDAR_CLIENT_ID and CALENDAR_CLIENT_SECRET server secrets.
Auth origin defaults to `https://auth.cqu.moe`; issuer remains
`https://auth.cqu.moe/api/auth`. PUBLIC_URL is the canonical application origin.
No public frontend environment variable contains the client secret.

Read-only production preflight (2026-10-09) identified client
`YKJBemjAnsyywZbkKlEZaqIXggTrILVp`, name `schedule`, enabled, skipConsent=true,
requirePKCE=true, callback `https://schedule.cqu.moe/callback`. Its scopes were
`openid profile email cqu:ticket:jwxt`; metadata was null. Before rollout:

- Keep default first-party authorization (`skipConsent=true`) and S256 PKCE.
- Configure confidential client authentication `client_secret_basic`, grants
  `authorization_code` and `refresh_token`, and add `offline_access` while keeping
  approved existing scopes. The browser flow requests openid/profile/email/offline_access.
- Set admin-controlled metadata `subsystem: "calendar"` and approved private RPC
  methods `getCaps`, `getCquTicket`, `cquHarvest` (preserve any other valid metadata).
- Deploy Auth's current-session introspection contract before this consumer.
  That contract supplies only the client's current calendar caps and binding state;
  scoped profile/email are read from native userinfo.

These are deployment prerequisites, not production changes made by this branch.
Secret rotation invalidates encrypted local records and requires a fresh login.
Auth central Cookie hardening must wait for every consumer's migration (#51).

## Runtime behavior

GET `/api/v2/auth/login?returnTo=/dashboard` creates a ten-minute encrypted D1
transaction, binds it to a separate host-only browser cookie, and redirects with
random state, nonce and S256 PKCE. Callback atomically consumes that transaction,
validates the code, ID-token signature, issuer, audience, nonce and userinfo subject,
then rotates the local session. Return destinations are constrained to this origin.

Access/refresh credentials are AES-GCM encrypted in D1 using a purpose-separated
key derived from the high-entropy client secret. D1 stores the hash of the random
session cookie. Local sessions have an absolute seven-day lifetime. Expired rows
are removed when a new login starts. No tokens are placed in frontend storage.

Each protected request queries native authenticated introspection. Missing,
malformed or unavailable authority fails closed; there is no positive browser
identity cache. Expired access credentials rotate only through the native token
endpoint. A D1 compare-and-swap refresh lease prevents concurrent token reuse;
a losing request receives retryable 503 rather than deleting a successful session.
The session revision also prevents a delayed refresh from recreating a logout.

POST `/api/v2/auth/logout` requires the configured application Origin, deletes only
that local session and redirects to `/signed-out`. This page waits for an explicit
login click. Unsafe protected requests also require the exact application Origin,
so another cqu.moe subdomain cannot submit writes using SameSite cookies.

Central logout, account bans and client disablement deny subsequent protected
requests through introspection. Business caps remain admin-controlled and current.
Private RPC background sync remains independent of these browser records; no
per-user background refresh credentials or new service registry were introduced.
The existing background caps cache is not an interactive identity cache.

## Local joint browser fixture

Use dedicated local hosts, not just different ports, for Cookie isolation:
`auth.localhost:8789` and `schedule.localhost:8790`. Start Auth's local fixture and
register a confidential fixture client with callback
`http://schedule.localhost:8790/callback`, metadata/scopes as above. Use only fixture
credentials, stored in an untracked .dev.vars. For Schedule set:

```
PUBLIC_URL=http://schedule.localhost:8790
AUTH_ORIGIN=http://auth.localhost:8789
ENVIRONMENT=development
CALENDAR_CLIENT_ID=<fixture-client>
CALENDAR_CLIENT_SECRET=<fixture-secret>
```

Run `npm ci`, install frontend dependencies with its pinned pnpm, build frontend,
apply `npm run db:migrate:local`, then `npx wrangler dev --port 8790`.
OAuth HTTP transport is allowed only for localhost/.localhost in development;
production OAuth requires HTTPS. Secure __Host cookies are retained locally;
use local HTTPS if the test browser does not grant localhost secure-cookie handling.
Use the normal AuthService binding for background RPC. DEV_AUTH_MOCK no longer
creates a browser identity; OAuth must complete even in a local fixture.

Primary protocol tests: `npm test -- src/routes/application-auth.test.ts`.
They use real Hono/D1, signed ID tokens, one-time code exchange, PKCE and rotating
refresh credentials. External Auth HTTP is a protocol fixture, not live production.
Existing business tests supply identity context and continue testing ownership,
quotas and synchronization independently. Parent task owns joint browser checks:
login, cookies across hosts, explicit local logout, central revocation and sync.

Design versions: theme/ui 1.1.0, existing PageHeader/PageState/Button reused.
Build and design checks do not assert visual acceptance; viewport/theme checks,
Safari/Firefox, real-device and accessibility acceptance remain separate.
