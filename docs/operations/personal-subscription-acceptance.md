# Personal subscription acceptance

Date: 2026-09-15. Business baseline: `6cef19a7781169b7409e46b37723578486e559d0`. Implementation worktree: `codex/personal-subscription-plan`.

## Delivered behavior

- One `subscriptions.source_type='personal'` row owns the complete course/exam snapshot, sync state, run ID, manual cooldown, entitlement state, and scheduler lifecycle for each user.
- Three rows in `personal_subscription_views` preserve the existing `personal_all`, `personal_courses`, and `personal_exams` transport shape, IDs, names, ordering, and per-view links without adding sync state.
- Authenticated GET provisioning derives the fixed personal resource from `calendar.sync`, independent of `sub_limit`. Binding-required and binding-unknown states persist explicit errors without Queue work.
- `POST /api/v2/subscriptions/personal/syncs` accepts no identity or view parameter. It claims the current session user's canonical row, sends one Queue message, consumes one daily manual allowance, and returns all three affected view IDs.
- Legacy `POST /:sid/syncs` resolves a personal view to the same service. External subscription refresh remains on the by-ID path and remains frozen by the existing guard.
- Cron, initial dispatch, and enabled-mode admin refresh claim the same canonical row. Only a queued row for the same run can atomically enter running. A duplicate running delivery retries after 60 seconds without harvesting; a running row older than 14 minutes becomes `SYNC_INTERRUPTED` without overwriting its snapshot.
- A successful personal harvest writes the complete snapshot and success state in one guarded update matching canonical ID, run ID, and `running`. Notifications run only after that update changes one row.
- Public ICS, origin JSON, formatted JSON, CSV, and web view output use the immutable scope stored on each link. Query parameters cannot broaden a course-only or exam-only link.
- Personal built-ins cannot be created or deleted. Link sharing remains available per view. During migration mode, personal setup, sync, Cron/admin refresh, Queue consumption, and link writes are paused while public tokens remain readable.
- The frontend keeps the existing three-card structure and feedback. The top control and each personal card issue one parameterless personal request; external cards keep by-ID refresh. Personal delete actions are absent and stale dialog state is rejected.

## Automated acceptance

The final verification commands are:

```text
npm test
npm run typecheck
npm --prefix frontend test
npm --prefix frontend run build
git diff --check
```

Fresh final results on the tree prepared for review:

- backend: 37 files passed; 377 tests passed and 21 existing tests skipped;
- frontend: 23 files passed; 293 tests passed and 13 existing tests skipped;
- TypeScript typecheck: passed;
- Vite production build: passed;
- `git diff --check`: passed.

The backend suite uses `readD1Migrations()` and `applyD1Migrations()` for the new schema and migration acceptance. Root Vitest is scoped to `src/**/*.test.ts`; before this change it also collected the frontend suite without the frontend alias and failed before producing a valid combined result. The frontend continues to run from its own config.

Targeted D1 coverage applies the real migration chain and verifies:

- a second canonical personal row for one user is rejected;
- one canonical has exactly three distinct view types;
- all seven non-empty subsets of the three legacy types convert to one canonical and three views;
- every old view ID and token remains present;
- missing views/default links are created without Queue sends;
- repeat apply is idempotent;
- global verify reports zero legacy rows, missing views, missing defaults, missing tokens, orphan rows, duplicate canonicals, and foreign-key violations;
- queued-to-running has one winner, stale runs cannot write, interrupted runs keep old data, and duplicate delivery performs one harvest;
- external rows never receive personal data;
- personal create/delete and stale frontend delete state do not mutate personal resources.

## Browser acceptance

Ego Browser space 13 was reused; no Chrome session was opened. A local Vite page used a loopback-only synthetic API fixture with three personal cards. The completed desktop and 390px mobile captures are stored in ignored local files:

- `.superpowers/ui-after-desktop.png`
- `.superpowers/ui-after-mobile.png`

The three cards, badges, copy, QR, preview, downloads, and share management remained visible. Opening a personal card's action menu showed share/download actions and no delete action. Resource timing was cleared before each interaction; the top button and each of the three card buttons independently recorded exactly one `/api/v2/subscriptions/personal/syncs` request and zero `/:sid/syncs` requests.

The supplied before captures stopped at the production loading state and did not contain rendered cards, so they are not valid pixel-comparison evidence. The completed local captures plus the four-file frontend diff show that no CSS, card structure, store, response type, counter, or Add page was changed. Production visual and real-account acceptance remain release-stage evidence.

## Migration rehearsal result

Local migration tests use synthetic data only and expose counts, never token or backup payload values. Across the seven legacy type combinations, each completed user has one canonical, three views, and one default link per scope. Old-token loss, legacy rows, orphan rows, duplicate canonicals, and foreign-key violations are zero in global verify. The admin route independently exercises authenticated apply in migration mode.

The operator contract is documented in `docs/operations/personal-subscription-migration.md`:

```json
{"mode":"dry_run","limit":10,"after_user_id":null}
```

```json
{"mode":"apply","limit":10,"after_user_id":null}
```

Use each non-null `next_cursor` unchanged. Finish with:

```json
{"mode":"verify","limit":10,"after_user_id":null}
```

All calls are `POST /api/v2/admin/personal-subscription-migration` with the existing `ADMIN_SECRET` bearer authentication. Apply is accepted only when `PERSONAL_SUBSCRIPTION_MODE=migration`; each user is one D1 batch.

## Release handoff

`wrangler.jsonc` is intentionally staged at `PERSONAL_SUBSCRIPTION_MODE=migration` for the first Git Connector deployment. This is the safe direct-release path selected to avoid a redundant compatibility build: migration `0011` remains additive, public legacy tokens remain readable, and all personal writers are paused. After the new version has replaced old consumers, the operator records a recovery point, runs dry-run, applies every cursor batch, and requires global verify to be completely zero. The release coordinator then changes the mode to `enabled`, pushes through Git Connector, and performs one authorized real-account sync plus D1/Queue/token verification.

No push, deployment, remote D1 mutation, production Queue message, or real-account sync was performed in this implementation worktree.

## Known limits and plan deviations

- The frontend still counts three projected cards against `sub_limit` and may block external add early. This is the accepted consequence of preserving the existing store/count behavior.
- Queue delivery is at least once. Run/state guards prevent duplicate harvesting for a live run under tested concurrency, but the system does not claim physical exactly-once delivery.
- Existing legacy test files retain their isolated hand-written schemas; the new canonical schema and all migration acceptance tests use the real migration chain. This avoided rewriting unrelated historical fixtures while still exercising the production migration SQL.
- The plan's final repository mode was `enabled`. This implementation commit remains at `migration` because enabling before the operator conversion would allow writes against unmigrated data. The release coordinator owns the post-verify mode flip.
- The optional one-build release path deploys additive schema and compatibility code directly in migration mode after focused review. It preserves the same backup, old-token, per-user atomicity, and global verify requirements as the longer legacy-then-migration sequence.
