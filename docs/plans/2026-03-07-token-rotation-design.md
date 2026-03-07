# Token Rotation Design

Issue: #64

## Background

From OWASP Top 10 audit (A07 - Authentication Failures). `calendar_token` cannot be rotated once generated. If leaked, user must delete account and re-register.

## Scope

Two independent operations:

1. **Auth token rotation** — rotates `users.calendar_token` (used as Bearer token for API auth)
2. **Subscription URL rotation** — rotates `subscriptions.calendar_token` (used in ICS URLs)

## Database Changes

`users` table adds two columns:

| Column | Type | Constraints |
|--------|------|-------------|
| `pending_calendar_token` | TEXT | UNIQUE, NULLABLE |
| `pending_token_expires_at` | TEXT | NULLABLE (ISO 8601) |

Single migration, no data backfill needed.

## Auth Token Rotation (Two-Step Confirm)

### Why two steps

The user's `calendar_token` doubles as their API credential. To prevent accidental lockout, the user must prove they have saved the new token before it takes effect.

### API

**`POST /api/v1/users/me/rotate-token`** (prepare)
- Middleware: `requireAuth` + `AUTH_LIMITER`
- Generate new token via `generateToken()`
- Defensive check: verify new token doesn't collide with any existing `users.calendar_token` or `subscriptions.calendar_token`
- Write `pending_calendar_token` + `pending_token_expires_at` (now + 10 minutes)
- Response: `{ new_token: "xxx" }`

**`POST /api/v1/users/me/rotate-token/confirm`** (confirm)
- Middleware: `requireAuth` + `AUTH_LIMITER`
- Body: `{ token: "user-entered token" }`
- Validation:
  - `pending_calendar_token` exists → else `PENDING_NOT_FOUND` 404
  - `pending_token_expires_at > now` → else `PENDING_EXPIRED` 410
  - `token` matches `pending_calendar_token` (timing-safe compare) → else `TOKEN_MISMATCH` 422
- On success: set `calendar_token = pending_calendar_token`, clear both pending columns
- Response: `{ calendar_token: "new-token" }`

### Frontend Flow

Three-page AlertDialog in the "danger zone" section of Dashboard:

**Page 1 (展示新 token):**
- Call prepare API
- Display new token (monospace, copy button, `<onepassword-save-button>` via `buildOPSaveValue()`)
- Hint: "请妥善保存新 Token，关闭后将无法再次查看"
- Button: "我已保存，下一步"

**Page 2 (盲输验证):**
- New token is NOT visible
- Input field, placeholder "请输入新 Token"
- "确认轮换" button disabled until input is non-empty
- Submit calls confirm API
- On mismatch: inline error (not toast)
- On expired: prompt user to restart

**Page 3 (成功):**
- Update `localStorage` and auth store `token` with new token
- Call `fetchUserInfo()` to refresh
- Toast: "Token 已轮换"
- Stay on Dashboard

## Subscription URL Rotation

### API

**`POST /api/v1/subscriptions/:sub_token/rotate`** (single)
- Middleware: `requireAuth` + `AUTH_LIMITER`
- Generate new token, check no collision with `users.calendar_token` and `subscriptions.calendar_token`
- Update `subscriptions.calendar_token` in-place
- Response: `{ calendar_token: "new", subscription_url: "full-url" }`

**`POST /api/v1/subscriptions/rotate-all`** (all)
- Middleware: `requireAuth` + `AUTH_LIMITER`
- Generate new tokens for all user's subscriptions, check no collisions
- Update all in a single transaction
- Response: `{ count: N }`

### Frontend Flow

**Single subscription rotate:**
- Add "重置链接" button to each subscription card (similar style to "删除")
- AlertDialog warning: "重置后旧的订阅链接将立即失效，日历客户端需要重新订阅"
- On confirm: call rotate API, reload subscription list

**Rotate all:**
- Add "重置所有链接" button near subscription list header
- AlertDialog warning with same message
- On confirm: call rotate-all API, reload subscription list

## Token Collision Check

`generateToken()` produces 48 random bytes (384 bits of entropy). Collision probability is ~2^(-384), effectively zero. However, as a defensive measure:

After generating a new token, verify it doesn't exist in:
1. `users.calendar_token`
2. `subscriptions.calendar_token`

If collision detected, regenerate (loop with max retries).

## Rate Limiting

All rotation endpoints use `AUTH_LIMITER` (same as other authenticated operations).

## Testing

### Backend
- prepare: generates pending token, writes to DB, correct expiry
- confirm: match succeeds and replaces, mismatch returns error, expired returns error
- single subscription rotate: token replaced, old token 404
- rotate-all: batch replacement, returns correct count
- collision check: mock `generateToken` to return existing value first, then unique value

### Frontend
- Three-page dialog flow (display → blind input → success)
- Input mismatch shows inline error
- Expired token prompts restart
- Auth store updated on success
- Subscription rotate confirmation dialogs
- Subscription list refreshes after rotation
