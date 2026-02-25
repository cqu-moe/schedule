# Cloudflare Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate CQU Schedule Subscription Service from FastAPI + PostgreSQL on VPS to Cloudflare Workers + D1, keeping VPS only for Playwright login.

**Architecture:** Single CF Worker (Hono + Drizzle ORM + D1) serving both API and frontend static assets. VPS Playwright service accessed via CF Tunnel + Access Service Token. Cron Triggers for scheduled tasks.

**Tech Stack:** TypeScript, Hono, Zod, Drizzle ORM, Cloudflare Workers/D1/Cron Triggers, Web Crypto API (AES-256-GCM), Vue 3 (unchanged frontend)

**Source reference:** Original Python codebase at `/Users/uu/Documents/Coding/cqu-moe/schedule` -- refer to it for exact business logic.

---

## Phase 1: Project Scaffolding

### Task 1: Initialize Workers + Hono Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `src/index.ts`
- Create: `src/types.ts`

**Step 1: Initialize project**

```
npm init -y
npm install hono @hono/zod-openapi zod drizzle-orm
npm install -D wrangler drizzle-kit typescript @cloudflare/workers-types vitest
```

**Step 2: Create tsconfig.json**

Target ESNext, module ESNext, bundler moduleResolution, types from @cloudflare/workers-types, strict mode.

**Step 3: Create wrangler.jsonc**

Configure: name "schedule", main "src/index.ts", compatibility_date "2026-02-26", nodejs_compat flag, assets directory "./frontend/dist" with SPA fallback, D1 binding "DB", three rate limit bindings (UNAUTH_LIMITER 5/60s, AUTH_LIMITER 20/60s, EXPLORE_LIMITER 10/60s), cron triggers ("0 */3 * * *" and "0 19 * * *").

**Step 4: Create src/types.ts**

Define Env interface with all bindings: DB (D1Database), rate limiters (RateLimit), secrets (ENCRYPTION_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, HCAPTCHA_SECRET), env vars (PUBLIC_URL, PLAYWRIGHT_URL, HCAPTCHA_ENABLED, HCAPTCHA_SITEKEY, MAX_SUBSCRIPTIONS, GIT_COMMIT, GIT_DATE).

**Step 5: Create minimal src/index.ts**

Hono app with health endpoint, scheduled handler stub. Export default { fetch, scheduled }.

**Step 6: Verify dev server**

Run `npx wrangler dev`, test GET /api/v1/health.

**Step 7: Commit** -- "feat: initialize Workers + Hono project scaffold"

---

### Task 2: Set Up Drizzle ORM Schema + D1

**Files:**
- Create: `src/db/schema.ts`
- Create: `drizzle.config.ts`

**Step 1: Create drizzle.config.ts**

Schema path ./src/db/schema.ts, output ./drizzle/migrations, dialect sqlite.

**Step 2: Create src/db/schema.ts**

Port SQLAlchemy models from `schedule/app/models/user.py` and `schedule/app/models/subscription.py`.

Users table: id (text PK, UUID), studentId (unique), encryptedPassword, accessToken, refreshToken, tokenExpiresAt (ISO 8601 text), calendarToken (unique, 64-char), lastLoginAt, lastRefreshAt, loginError, createdAt, updatedAt.

Subscriptions table: id (text PK, UUID), userId (FK to users with cascade delete), sourceType, sourceId, sourceName, calendarToken (unique), sessionId, sessionName, semesterStart, isPersonal (integer boolean), icsContent, coursesJson (JSON as text), examsJson (JSON as text), lastSyncedAt, createdAt, updatedAt. Unique index on (userId, sourceType, sourceId, sessionId).

**Step 3: Create D1 database and generate migration**

```
npx wrangler d1 create schedule-db
npx drizzle-kit generate
```

Update wrangler.jsonc with actual database_id.

**Step 4: Apply migration locally**

```
npx wrangler d1 migrations apply schedule-db --local
```

**Step 5: Commit** -- "feat: add Drizzle ORM schema and D1 migration"

---

## Phase 2: Core Services

### Task 3: AES-256-GCM Crypto Module

**Files:**
- Create: `src/services/crypto.ts`
- Create: `src/services/crypto.test.ts`

Port from: `schedule/app/services/crypto.py` (Fernet to AES-256-GCM)

**Step 1: Write test**

Tests: encrypt/decrypt roundtrip, different ciphertexts for same plaintext (random IV), verifyPassword correct/wrong.

**Step 2: Run test to verify it fails**

```
npx vitest run src/services/crypto.test.ts
```

**Step 3: Implement src/services/crypto.ts**

Functions: `encrypt(plaintext, keyBase64)`, `decrypt(data, keyBase64)`, `verifyPassword(password, encrypted, keyBase64)`.

Implementation: Web Crypto API `crypto.subtle.importKey` with AES-GCM, 12-byte random IV, concatenate IV + ciphertext as base64. Decrypt reverses: split IV (first 12 bytes) and ciphertext, decrypt.

Helper functions: `base64ToBuffer`, `bufferToBase64` using atob/btoa.

**Step 4: Run tests -- all pass**

**Step 5: Commit** -- "feat: add AES-256-GCM crypto module with tests"

---

### Task 4: CQU API Data Types + Client

**Files:**
- Create: `src/services/cqu-api.ts`

Port from: `schedule/app/services/cqu_api.py` and `schedule/worker/app/services/cqu_api.py`

**Step 1: Implement**

Constants: SCHEDULE_URL, EXAM_URL, SESSION_LIST_URL, SESSION_DETAIL_URL, TIME_SLOTS (14 periods).

Types: CourseEntry, ExamEntry interfaces.

CQUAPIClient class with:
- Constructor takes accessToken
- Private request() method using fetch() with Bearer auth
- getSessionList(): parse curSessionId and sessionFinder
- getSemesterInfo(termId): parse beginDate, endDate
- getSchedule(studentId, termId): parse classTimetableVOList with teachingWeek bitstring and period bitstring
- getExams(): parse exam data with date/time combination
- Search methods (from worker/app/services/cqu_api.py): searchInstructor, searchRoom, searchLaboratory, searchCourse, searchAdminClass, getDepartments, fetchTargetSchedule

Key parsing detail from original code:
- teachingWeek is a bitstring where index i = week i+1
- period is a bitstring where first "1" = startSession, last "1" = endSession
- instructorName cleaned with regex `(.*?)-\d`

**Step 2: Commit** -- "feat: port CQU API client and data types to TypeScript"

---

### Task 5: ICS Generator

**Files:**
- Create: `src/services/ics.ts`
- Create: `src/services/ics.test.ts`

Port from: `schedule/app/services/ics_generator.py`

**Step 1: Write tests**

Test generateCoursesIcs: verify VCALENDAR structure, correct number of VEVENTs, DTSTART/DTEND in UTC format, VALARM with -PT15M trigger.

Test generateExamsIcs: verify exam events with -PT1H alarm.

Test mergeIcs: verify merged output contains events from both.

**Step 2: Run tests -- fail**

**Step 3: Implement src/services/ics.ts**

Functions: generateCoursesIcs(courses, semesterStart, username), generateExamsIcs(exams, username), mergeIcs(coursesIcs, examsIcs).

Helpers: calculateEventTime(termStart, week, dayOfWeek, session, isStart), formatIcsTime(date) to YYYYMMDDTHHMMSSZ, generateUid(username, summary, start, end) using SHA-256 + base64.

Line separator: \r\n. Header: BEGIN:VCALENDAR, VERSION:2.0, PRODID:-//CQU Schedule//CN, CALSCALE:GREGORIAN, METHOD:PUBLISH.

**Step 4: Run tests -- pass**

**Step 5: Commit** -- "feat: port ICS generator with tests"

---

### Task 6: Export Generator (JSON/CSV)

**Files:**
- Create: `src/services/export.ts`
- Create: `src/services/export.test.ts`

Port from: `schedule/app/services/export_generator.py`

**Step 1: Write tests**

Test semesterShortName: "2025-2026学年第一学期" -> "2025秋", "2025-2026学年第二学期" -> "2026春", null -> "".

Test generateFormattedEvents: verify course expansion with concrete ISO datetimes, exam events passthrough.

Test generateCsv: verify BOM prefix, header row, CSV injection sanitization.

**Step 2: Implement**

Functions: semesterShortName(sessionName), generateFormattedEvents(coursesJson, semesterStart, examsJson?), generateCsv(events).

CSV fields: name, type, instructor, location, day_of_week, start_time, end_time, week.

Sanitize values starting with = + - @ by prefixing with '.

**Step 3: Run tests -- pass**

**Step 4: Commit** -- "feat: port export generator with tests"

---

### Task 7: VPS Worker Client (Playwright Service)

**Files:**
- Create: `src/services/worker-client.ts`

Port from: `schedule/app/services/worker_client.py`

**Step 1: Implement**

WorkerError class (message, code). TokenResult type (accessToken, refreshToken, expiresAt).

Functions: login(env, username, password), refreshToken(env, refreshTokenStr).

Internal workerRequest(env, path, body): POST to PLAYWRIGHT_URL with CF-Access-Client-Id and CF-Access-Client-Secret headers.

Error handling: parse JSON error response, throw WorkerError.

**Step 2: Commit** -- "feat: add VPS worker client with CF Access authentication"

---

## Phase 3: Middleware and Auth

### Task 8: Auth Middleware

**Files:**
- Create: `src/middleware/auth.ts`

Port from: `schedule/app/api/deps.py`

**Step 1: Implement**

Two Hono middlewares using createMiddleware:
- requireAuth: extract Bearer token, lookup user in D1, set user in context
- requireAuthWithCquToken: same + verify user has accessToken

**Step 2: Commit** -- "feat: add auth middleware"

---

### Task 9: Rate Limiting Middleware

**Files:**
- Create: `src/middleware/rate-limit.ts`

**Step 1: Implement**

Factory function rateLimit(limiterName) returning Hono middleware that calls env[limiterName].limit({ key: IP }).

**Step 2: Commit** -- "feat: add rate limiting middleware"

---

## Phase 4: API Routes

### Task 10: Health + Config + Captcha Routes

**Files:**
- Create: `src/routes/config.ts`

Port from: `schedule/app/api/health.py`, `schedule/app/api/config.py`, `schedule/app/api/captcha.py`

**Step 1: Implement**

GET /api/v1/health -> { status: "ok", commit, date }
GET /api/v1/config -> { public_url }
GET /api/v1/captcha/config -> { enabled, sitekey }

**Step 2: Commit** -- "feat: add health, config, captcha routes"

---

### Task 11: Users Routes

**Files:**
- Create: `src/routes/users.ts`

Port from: `schedule/app/api/users.py`

**Step 1: Implement POST /api/v1/users (register)**

Logic:
1. Rate limit (UNAUTH_LIMITER)
2. Validate captcha if enabled
3. Check if user exists by student_id
4. If new: call VPS login() -> encrypt password -> create user in D1 -> create 3 personal subscriptions -> fetch schedule from CQU API -> generate ICS -> return calendar_token
5. If exists: verify password -> update tokens -> return calendar_token

**Step 2: Implement DELETE /api/v1/users/me**

Auth required. Delete user (cascade deletes subscriptions).

**Step 3: Implement POST /api/v1/users/recover/verify**

Rate limited. Verify student_id + password match stored encrypted password.

**Step 4: Implement POST /api/v1/users/recover/refresh**

Rate limited, captcha. Call VPS login() to get fresh tokens, update user.

**Step 5: Wire into Hono app**

**Step 6: Commit** -- "feat: add users routes"

---

### Task 12: Subscriptions Routes

**Files:**
- Create: `src/routes/subscriptions.ts`

Port from: `schedule/app/api/subscriptions.py`

**Step 1: Implement CRUD endpoints**

- GET /api/v1/subscriptions (auth, list with subscription URLs)
- POST /api/v1/subscriptions (auth, captcha, create explore sub, max 5 check)
- DELETE /api/v1/subscriptions/:sub_token (auth, non-personal only)
- POST /api/v1/subscriptions/:sub_token/refresh (auth, re-fetch data)

**Step 2: Implement export endpoints**

- GET /api/v1/subscriptions/:sub_token/calendar.ics (public, Content-Type: text/calendar)
- GET /api/v1/subscriptions/:sub_token/origin.json (public, raw JSON)
- GET /api/v1/subscriptions/:sub_token/data.json (public, formatted events)
- GET /api/v1/subscriptions/:sub_token/data.csv (public, Content-Type: text/csv)

**Step 3: Commit** -- "feat: add subscriptions routes"

---

### Task 13: Explore Routes

**Files:**
- Create: `src/routes/explore.ts`

Port from: `schedule/app/api/explore.py`

**Step 1: Implement**

- GET /api/v1/search (auth + CQU token, EXPLORE_LIMITER). Uses CQUAPIClient directly.
- GET /api/v1/departments (auth + CQU token). Uses CQUAPIClient directly.

Important: CF Worker calls CQU API directly (overseas accessible), not via VPS.

**Step 2: Commit** -- "feat: add explore routes"

---

### Task 14: Wire All Routes + App Entry

**Files:**
- Modify: `src/index.ts`

**Step 1: Import and mount all route groups**

Mount: /api/v1/users, /api/v1/subscriptions, /api/v1 (explore + config).

**Step 2: Add CORS middleware if needed (likely not needed since same-origin)**

**Step 3: Test with wrangler dev**

**Step 4: Commit** -- "feat: wire all routes into app entry"

---

## Phase 5: Cron Jobs

### Task 15: Token Refresh Cron

**Files:**
- Create: `src/cron/token-refresh.ts`

Port from: `schedule/app/tasks/scheduler.py:refresh_all_tokens` and `schedule/app/services/token.py`

**Step 1: Implement refreshExpiringTokens(env)**

Query users with tokenExpiresAt within 1 hour. For each: try refreshToken via VPS, fallback to login with decrypted password. Update D1.

**Step 2: Commit** -- "feat: add token refresh cron job"

---

### Task 16: Schedule Sync Cron

**Files:**
- Create: `src/cron/schedule-sync.ts`

Port from: `schedule/app/tasks/scheduler.py:update_all_subscriptions`

**Step 1: Implement syncAllSubscriptions(env)**

Query all users with valid access tokens. For each user, fetch schedule from CQU API (cache personal fetch per user). Regenerate ICS for each subscription. Update D1.

**Step 2: Wire both crons into scheduled handler in src/index.ts**

```typescript
async scheduled(controller, env, ctx) {
  switch (controller.cron) {
    case '0 */3 * * *': ctx.waitUntil(refreshExpiringTokens(env)); break
    case '0 19 * * *': ctx.waitUntil(syncAllSubscriptions(env)); break
  }
}
```

**Step 3: Commit** -- "feat: add schedule sync cron job"

---

## Phase 6: Frontend Integration

### Task 17: Frontend Build + Static Assets

**Files:**
- Copy: `schedule/frontend/` to `schedule-cloudflare/frontend/`
- Possibly modify: `frontend/src/api/index.js` (API base URL)

**Step 1: Copy frontend directory**

**Step 2: Check if API base URL needs changing**

Since Workers Static Assets serves both frontend and API on same origin, the existing relative URL `/api/v1/` should work without changes.

**Step 3: Install and build**

```
cd frontend && npm install && npm run build
```

**Step 4: Test with wrangler dev**

Verify Vue SPA loads and API calls work end-to-end.

**Step 5: Commit** -- "feat: integrate frontend as Workers Static Assets"

---

## Phase 7: Deployment and Data Migration

### Task 18: CF Tunnel + Access Setup (Manual)

Dashboard configuration, not code:
1. Create CF Tunnel for VPS (playwright.yourdomain.com)
2. Create Access Service Token
3. Create Access policy allowing only that token
4. Add Worker secrets via wrangler secret put

---

### Task 19: Data Migration Script

**Files:**
- Create: `scripts/migrate-data.ts`

**Step 1: Write migration script**

Connect to PostgreSQL, read users and subscriptions, decrypt passwords with Fernet key, re-encrypt with AES-256-GCM, insert into D1 via wrangler d1 execute.

**Step 2: Test with small dataset**

**Step 3: Run full migration**

**Step 4: Verify integrity** -- count check, spot-check passwords

---

### Task 20: Deploy + DNS Cutover

**Step 1:** `npx wrangler deploy`
**Step 2:** Apply D1 migration to production
**Step 3:** Run data migration
**Step 4:** Configure custom domain in CF dashboard
**Step 5:** Verify all endpoints
**Step 6:** DNS cutover
**Step 7:** VPS downgrade (keep only Playwright)

---

## Task Dependency Graph

```
Phase 1: Scaffolding (Tasks 1-2)
  |
  +-> Phase 2: Core Services (Tasks 3-7) -- parallelizable
  |     Task 3: Crypto
  |     Task 4: CQU API
  |     Task 5: ICS Generator
  |     Task 6: Export Generator
  |     Task 7: Worker Client
  |
  +-> Phase 3: Middleware (Tasks 8-9) -- depends on schema
  |     Task 8: Auth
  |     Task 9: Rate Limiting
  |
  +-> Phase 4: API Routes (Tasks 10-14) -- depends on services + middleware
  |     Task 10: Health/Config
  |     Task 11: Users (depends on 3,4,5,7,8,9)
  |     Task 12: Subscriptions (depends on 4,5,6,8)
  |     Task 13: Explore (depends on 4,8)
  |     Task 14: Wire routes
  |
  +-> Phase 5: Cron (Tasks 15-16) -- depends on services
  |
  +-> Phase 6: Frontend (Task 17) -- independent
  |
  +-> Phase 7: Deploy (Tasks 18-20) -- depends on all above
```

**Total: 20 tasks across 7 phases. Phase 2 tasks (3-7) are parallelizable.**
