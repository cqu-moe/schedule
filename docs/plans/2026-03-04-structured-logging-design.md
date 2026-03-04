# Structured Logging Design

Issue: #45

## Goal

Convert all 21 console.log/warn/error calls from string concatenation to structured JSON, enabling filtering and aggregation in Workers Observability dashboard.

## Approach

Direct `console.log(JSON.stringify({...}))` at each call site. No helper, no library.

## Field Specification

**Required fields:**
- `event` — dot-separated event name: `<context>.<subsystem>.<action>`
- `message` — human-readable description

**Optional fields (by context):**
- `studentId` — user identifier (queue consumer logs)
- `count` — quantity (cron producer enqueue count)
- `source` — subscription source name (sync logs)
- `error` — error message string (error-level logs)
- `errorCode` — auth error code like `INVALID_CREDENTIALS`
- `stack` — stack trace (unhandled errors only)
- `cron` — cron expression (unknown cron)
- `queue` — queue name (unknown queue)

**Console level mapping:**
- `console.log` — normal events (start, success, enqueued, synced)
- `console.warn` — recoverable degradation (fallback login, partial failure + retry, unknown cron/queue)
- `console.error` — errors (failed, unhandled_error)

## Event Names

### Cron producers
- `cron.token_refresh.start` / `.skip` / `.enqueued`
- `cron.schedule_sync.start` / `.skip` / `.enqueued`

### Queue consumers — token refresh
- `queue.token_refresh.success`
- `queue.token_refresh.fallback_login`
- `queue.token_refresh.login_success`
- `queue.token_refresh.failed`

### Queue consumers — schedule sync
- `queue.schedule_sync.personal_failed`
- `queue.schedule_sync.explore_failed`
- `queue.schedule_sync.subscription_synced`
- `queue.schedule_sync.all_failed`
- `queue.schedule_sync.failed`

### HTTP handlers
- `http.unhandled_error`
- `http.unknown_cron`
- `http.unknown_queue`

### Registration
- `registration.sync_complete`
- `registration.sync_failed`

### Services
- `captcha.network_error`

## Files Changed

| File | Count |
|------|-------|
| src/cron/token-refresh.ts | 7 |
| src/cron/schedule-sync.ts | 8 |
| src/index.ts | 3 |
| src/routes/users.ts | 2 |
| src/services/captcha.ts | 1 |
| **Total** | **21** |

## Notes

- `http.unknown_cron` and `http.unknown_queue` upgraded from `console.log` to `console.warn`
- `http.unhandled_error` includes `stack` field when available
- Error extraction: `e instanceof Error ? e.message : String(e)`
- Prerequisite #41 (enable observability) already closed
