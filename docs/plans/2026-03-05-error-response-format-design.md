# Standardize Error Response Format

Issue: #31

## Problem

API has two error response formats, increasing frontend complexity:

- **Format A (structured):** `{ detail: { error: { code, message } } }` — 4 places in `src/routes/users.ts`
- **Format B (string):** `{ detail: "message" }` — 31+ places across all routes/middleware

## Decision

Unify all errors to structured format A.

## Unified Format

```json
{ "detail": { "error": { "code": "ERROR_CODE", "message": "Human-readable message" } } }
```

## Shared Utility

Extract `errorResponse(code, message, status)` from `src/routes/users.ts` to `src/utils/error.ts`. All routes and middleware import from there.

## Error Code Strategy (Mixed Granularity)

### Fine-grained (business semantics)

| Code | Status | Context |
|------|--------|---------|
| `INVALID_CREDENTIALS` | 401 | Login/recovery auth failure |
| `PASSWORD_MISMATCH` | 422 | Recovery password mismatch |
| `UPSTREAM_ERROR` | 502 | CQU API failure |
| `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` | 403 | Captcha verification |
| `TOKEN_EXPIRED` | 401 | CQU OAuth token expired |
| `SUBSCRIPTION_DUPLICATE` | 409 | Subscription already exists |
| `MAX_SUBSCRIPTIONS` | 409 | Subscription limit reached |
| `DATA_CORRUPTED` | 500 | Stored data corruption |

### Generic (validation / HTTP semantics)

| Code | Status | Context |
|------|--------|---------|
| `BAD_REQUEST` | 400 | Input validation errors |
| `UNAUTHORIZED` | 401 | Missing/invalid auth header |
| `FORBIDDEN` | 403 | Forbidden action |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Backend Changes

### `src/utils/error.ts`

Add shared `errorResponse()`:

```typescript
export function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { detail: { error: { code, message } } },
    { status },
  );
}
```

### Files to update

- `src/index.ts` — global error handler: `INTERNAL_ERROR`
- `src/middleware/auth.ts` — `UNAUTHORIZED`, `TOKEN_EXPIRED`
- `src/middleware/rate-limit.ts` — `RATE_LIMITED`
- `src/routes/users.ts` — remove local `errorResponse()`, import shared one; update format B calls
- `src/routes/subscriptions.ts` — all format B calls
- `src/routes/explore.ts` — all format B calls
- `src/utils/error.ts` — `handleCQUAPIError` update to use `errorResponse()`

## Frontend Changes

### `frontend/src/utils/error.ts`

Simplify `parseApiError()` to only handle format A:

```typescript
export function parseApiError(error): string {
  const detail = error.response?.data?.detail;
  if (!detail) return DEFAULT_MESSAGE;
  const code = detail?.error?.code;
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  return detail?.error?.message ?? DEFAULT_MESSAGE;
}
```

Add `RATE_LIMITED` to `CODE_MESSAGES`.

### `frontend/src/api/index.js`

Remove 429 body override from axios interceptor. Add fallback for 429 with no body:

```javascript
client.interceptors.response.use(undefined, (error) => {
  if (error.response?.status === 429 && !error.response?.data?.detail) {
    error.response.data = { detail: { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } } };
  }
  return Promise.reject(error);
});
```

## Test Changes

Update backend tests that assert on error response format to expect the new structured format. Update frontend `parseApiError` tests.
