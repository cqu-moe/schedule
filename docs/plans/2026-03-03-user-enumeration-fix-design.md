# Fix User Enumeration on Registration (Issue #15)

## Problem

Registration endpoint returns 409 `USER_EXISTS` when a student_id is already registered, allowing attackers to enumerate which student IDs have accounts. Similarly, `recover/verify` returns 401 before SSO verification when the user doesn't exist.

The `recover` (password) endpoint is already correct — it returns `PASSWORD_MISMATCH` for both "user not found" and "wrong password".

## Approach: SSO-First Verification

Move SSO `login()` before the DB lookup on both vulnerable endpoints. This eliminates response differentiation and timing side-channels, since the expensive SSO call always happens regardless of user existence.

## Registration Endpoint (`POST /api/v1/users`)

**Current flow:** Query DB → 409 if exists → SSO login → create user → 200

**New flow:**

1. SSO `login()` — validates credentials first
2. Query DB for `student_id`
3. **Not found:** Create new user, encrypt and store tokens, return 200 + `calendar_token`
4. **Found:** Update encrypted OAuth tokens in DB (keeps them fresh), return 200 + existing `calendar_token`

Key details:

- Response is always 200 with identical body shape (`{ calendar_token, student_id }`)
- Existing user's `calendar_token` is preserved (not regenerated)
- OAuth tokens are updated on re-registration, acting as an implicit token refresh
- Wrong password is rejected by SSO before any DB interaction

## Recovery Verify Endpoint (`POST /api/v1/users/recover/verify`)

**Current flow:** Query DB → 401 if not found → SSO login → update password/tokens → 200

**New flow:**

1. SSO `login()` — validates credentials first
2. Query DB for `student_id`
3. **Found:** Update password hash + OAuth tokens, return 200 + `calendar_token`
4. **Not found:** Return `INVALID_CREDENTIALS` error (same error code as SSO auth failure)

Key details:

- Timing is consistent because SSO call always happens first
- Error code `INVALID_CREDENTIALS` is indistinguishable from SSO authentication failure
- `POST /api/v1/users/recover` (password recovery) is already correct, no changes needed

## Frontend Cleanup

- Remove `USER_EXISTS` from `CODE_MESSAGES` in `frontend/src/utils/error.ts` (dead code after backend change)
- Update related tests in `frontend/src/utils/__tests__/error.test.ts` and `frontend/src/stores/__tests__/auth.test.ts`

## Testing

- **Registration:** Remove 409 `USER_EXISTS` test case. Add test for "user exists + correct password → 200 with existing token + OAuth tokens updated"
- **recover/verify:** Remove "user not found → 401" test case. Add test for "user not found + SSO passes → unified INVALID_CREDENTIALS error"
- **Frontend:** Update error mapping tests and auth store tests to remove USER_EXISTS cases

## Security Summary

| Endpoint | Before | After |
|----------|--------|-------|
| `POST /users` (register) | 409 leaks existence | 200 for both new and existing users |
| `POST /users/recover/verify` | 401 leaks non-existence | Unified `INVALID_CREDENTIALS` error |
| `POST /users/recover` | Already safe | No change |
