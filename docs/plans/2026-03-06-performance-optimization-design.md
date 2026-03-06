# Performance Optimization Design

Date: 2026-03-06

## Background

Full-stack performance audit identified 10 improvement areas. This design covers the top 8 by ROI, skipping ICS streaming and font preload.

## Scope

Single PR, 8 commits, covering backend DB/caching and frontend bundle/loading optimizations.

## 1. DB Index

Add index on `subscriptions(userId)` via Drizzle migration. `calendarToken` UNIQUE already has implicit SQLite index.

## 2. Subscription Duplicate Check Optimization

Replace current pattern (SELECT all user subscriptions + JS loop) with single SQL query:

```sql
SELECT 1 FROM subscriptions
WHERE user_id = ? AND source_type = ? AND source_id = ? AND session_id = ?
LIMIT 1
```

Hits existing UNIQUE index. Return 409 if exists.

## 3. Cache-Control Headers

| Endpoint | Header | Rationale |
|----------|--------|-----------|
| `GET /api/v1/users/me` | `private, max-age=60` | User info stable short-term |
| `GET /api/v1/subscriptions` | `private, max-age=10` | May update from sync |
| `GET /api/v1/config` (merged) | `public, max-age=300` | Config rarely changes |

No caching on POST/DELETE, auth endpoints, or ICS exports (already cached).

## 4. Merge Config API

Merge `GET /api/v1/config` and `GET /api/v1/config/captcha` into single endpoint:

```json
{
  "registration_enabled": true,
  "captcha": {
    "enabled": true,
    "sitekey": "xxx"
  }
}
```

Delete `/api/v1/config/captcha`. Internal API, no backward compatibility needed.

Frontend: merge `configStore.load()` and `loadCaptchaConfig()` into single `load()`. `App.vue` calls once.

## 5. Bundle Analyzer

Add `rollup-plugin-visualizer` to `frontend/vite.config.ts`, gated by `ANALYZE=true` env var. Output: `frontend/dist/stats.html`.

## 6. Vite Manual Chunks

```
vendor: vue, vue-router, pinia, axios
ui:     reka-ui, lucide-vue-next, class-variance-authority, clsx, tailwind-merge
```

Remaining deps use Vite default splitting.

## 7. hCaptcha Deferred Loading

`Add.vue`: wrap `<VueHcaptcha>` in `v-if`, mount only when user clicks add button AND `captcha.enabled === true`.

## 8. @vueuse/core Evaluation

After bundle analyzer is set up, run `ANALYZE=true npm run build:frontend` to measure actual @vueuse/core bundle contribution. Decision:
- < 5KB: keep as-is
- > 10KB: open follow-up issue to replace with custom useColorMode
