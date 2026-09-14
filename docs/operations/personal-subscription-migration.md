# Personal subscription migration runbook

This migration converts every user's legacy personal subscription rows into one canonical `source_type='personal'` row with three compatibility views. It preserves old view IDs and calendar tokens. The operator runs it once, in batches of at most ten users. The endpoint never logs or returns backup payloads or token values.

## Preconditions

1. Record a D1 export, Time Travel restore point, or equivalent recovery point and the deployed Git revision.
2. Deploy migration `0011_personal_subscription_views.sql` with the compatibility code.
3. Put the Worker in `PERSONAL_SUBSCRIPTION_MODE=migration` and confirm the new version has replaced old request and Queue consumers. In this mode existing public calendar tokens remain readable, while personal setup, manual sync, Cron, admin refresh, link writes, and legacy personal Queue messages are paused.
4. Keep the current compatibility version available for rollback. Do not roll back to code that cannot read canonical rows after any batch has been applied.

The normal rollout can deploy additive schema/code in `legacy` mode first, then switch to `migration`. A reviewed release may deploy the additive schema/code directly in `migration` mode to avoid a redundant build, provided the old writer is confirmed gone before `apply`. This shorter path does not change the backup, batch atomicity, token preservation, or global verification gates.

## Operator API

Use `POST /api/v2/admin/personal-subscription-migration` with the existing `ADMIN_SECRET` bearer authentication. Obtain the secret from the approved secret store and keep it out of documents, shell history, request logs, and screenshots.

Dry run is the default. The explicit first request body is:

```json
{"mode":"dry_run","limit":10,"after_user_id":null}
```

Apply a batch only in migration mode:

```json
{"mode":"apply","limit":10,"after_user_id":null}
```

If `next_cursor` is non-null, pass it unchanged as `after_user_id` in the next request. Stop on any non-200 response or incomplete user error, fix the cause, and retry from the last successful cursor. Each user is one D1 batch; a failure rolls back the backup, views, link moves, survivor update, and setup update together. A completed user is idempotently skipped on retry.

After the final apply batch, run a global verification:

```json
{"mode":"verify","limit":10,"after_user_id":null}
```

Do not enable personal writes until `complete=true` and every verification count is zero: `legacy_rows`, `missing_views`, `missing_defaults`, `missing_tokens`, `orphan_views`, `orphan_links`, `duplicate_personal`, and `foreign_key_violations`.

## Enable and accept

1. Change `PERSONAL_SUBSCRIPTION_MODE` to `enabled` and deploy through the repository's Cloudflare Git Connector.
2. Confirm each migrated user has one canonical row, three views, and one default link per view. Do not inspect or print token values during routine verification.
3. With the single authorized account, load Dashboard, issue one personal sync, and verify one Queue message, one run ID, one harvest, one guarded canonical write, and three API views showing the same final state.
4. Check the old all/courses/exams URLs in all allowed formats. Course links must exclude exams, exam links must exclude courses, and query parameters must not broaden scope.
5. Retain the migration backup table and restore point until the acceptance window closes.

If verification fails after a partial migration, stay in migration mode and resume forward from the stored backup and last cursor. Schema `0011` is additive; do not delete canonical rows or restore legacy rows through the production synchronizer.
