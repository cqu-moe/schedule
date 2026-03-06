# OWASP Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 security findings from OWASP Top 10 audit + create GitHub issues.

**Architecture:** Config changes + one small middleware enhancement. No new modules.

**Tech Stack:** Cloudflare Workers, Hono, axios, wrangler.jsonc

---

### Task 1: Create GitHub Issues

**Step 1: Create combined issue for fixes 1-3**

```bash
gh issue create \
  --title "OWASP security hardening: axios upgrade, workers_dev, auth logging" \
  --body "$(cat <<'BODY'
## From OWASP Top 10 Audit (2026-03-06)

### 1. Upgrade axios (A06 - Vulnerable Components)
- `axios` 1.13.4 has high-severity DoS vulnerability (GHSA-43fc-jf86-j433, CVSS 7.5)
- Fix: upgrade to >=1.13.5

### 2. Disable `workers_dev` (A05 - Security Misconfiguration)
- `workers_dev: true` exposes Worker at `*.workers.dev`, bypassing custom domain
- Fix: set `"workers_dev": false`

### 3. Add auth failure logging (A09 - Logging & Monitoring)
- Invalid token attempts not logged, can't detect brute-force
- Fix: add structured log with `CF-Connecting-IP` in auth middleware

Design doc: `docs/plans/2026-03-06-owasp-hardening-design.md`
BODY
)" \
  --label "security"
```

Note: if `security` label doesn't exist, omit `--label`.

**Step 2: Create separate issue for token rotation**

```bash
gh issue create \
  --title "feat: add calendar token rotation endpoint" \
  --body "$(cat <<'BODY'
## Background
From OWASP Top 10 audit (A07 - Authentication Failures).

`calendar_token` cannot be rotated once generated. If leaked, user must delete account and re-register.

## Proposed Solution
- Add `POST /api/v1/users/me/rotate-token` endpoint
- Generates new `calendar_token`, updates all subscription URLs
- Frontend: add button in user settings/dashboard
- Consider: should subscription-level `calendarToken` also rotate?

## Design considerations
- Old ICS URLs will break immediately for all calendar clients
- Need clear user warning before rotation
- Rotation should be rate-limited (AUTH_LIMITER)
BODY
)"
```

---

### Task 2: Upgrade axios

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Step 1: Upgrade axios**

```bash
cd frontend && npm update axios
```

Verify version >= 1.13.5:
```bash
node -e "console.log(require('axios/package.json').version)"
```

**Step 2: Run frontend tests to verify no regression**

```bash
cd frontend && npm test
```

Expected: all tests pass.

**Step 3: Run frontend build to verify no breakage**

```bash
cd frontend && npm run build
```

Expected: build succeeds.

---

### Task 3: Disable `workers_dev`

**Files:**
- Modify: `wrangler.jsonc:7`

**Step 1: Change `workers_dev` to `false`**

In `wrangler.jsonc` line 7, change:
```jsonc
"workers_dev": true,
```
to:
```jsonc
"workers_dev": false,
```

**Step 2: Verify wrangler config is valid**

```bash
npx wrangler deploy --dry-run 2>&1 | head -5
```

Expected: no config errors (may warn about missing frontend/dist, that's OK).

---

### Task 4: Add auth failure logging

**Files:**
- Modify: `src/middleware/auth.ts:43-45` and `src/middleware/auth.ts:72-78`

**Step 1: Add logging to `requireAuth`**

In `src/middleware/auth.ts`, after the `if (!user)` check (line 43), add a log before returning:

```typescript
  if (!user) {
    console.warn(JSON.stringify({
      event: "auth.invalid_token",
      ip: c.req.header("CF-Connecting-IP") ?? "unknown",
      path: c.req.path,
      message: "Invalid token",
    }));
    return errorResponse("UNAUTHORIZED", "Invalid token", 401);
  }
```

**Step 2: Add same logging to `requireAuthWithCquToken`**

Same pattern at the `if (!user)` check (around line 72):

```typescript
  if (!user) {
    console.warn(JSON.stringify({
      event: "auth.invalid_token",
      ip: c.req.header("CF-Connecting-IP") ?? "unknown",
      path: c.req.path,
      message: "Invalid token",
    }));
    return errorResponse("UNAUTHORIZED", "Invalid token", 401);
  }
```

**Step 3: Run backend tests**

```bash
npx vitest run --exclude 'frontend/**'
```

Expected: all tests pass (auth middleware is mocked in route tests, so existing tests unaffected).

---

### Task 5: Commit and create PR

**Step 1: Stage all changes**

```bash
git add frontend/package.json frontend/package-lock.json wrangler.jsonc src/middleware/auth.ts
```

**Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(security): OWASP hardening — axios upgrade, workers_dev, auth logging

- Upgrade axios to fix DoS vulnerability (GHSA-43fc-jf86-j433)
- Set workers_dev: false to prevent *.workers.dev exposure
- Add structured logging for invalid auth token attempts with IP

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

**Step 3: Create PR referencing the issue**

```bash
gh pr create \
  --title "fix(security): OWASP hardening — axios, workers_dev, auth logging" \
  --body "$(cat <<'EOF'
## Summary
- Upgrade frontend `axios` to fix high-severity DoS vulnerability (GHSA-43fc-jf86-j433)
- Set `workers_dev: false` to prevent `*.workers.dev` public access
- Add structured `console.warn` logging for invalid auth token attempts (includes IP + path)

Closes #<ISSUE_NUMBER>

## Test plan
- [ ] `cd frontend && npm test` — frontend tests pass
- [ ] `npx vitest run --exclude 'frontend/**'` — backend tests pass
- [ ] `cd frontend && npm run build` — frontend builds
- [ ] `npx wrangler deploy --dry-run` — wrangler config valid

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace `<ISSUE_NUMBER>` with the actual issue number from Task 1 Step 1.
