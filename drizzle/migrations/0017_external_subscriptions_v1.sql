-- Keep every existing record frozen in version 0. No target or entitlement backfill.
ALTER TABLE subscriptions ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN external_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE subscriptions ADD COLUMN target_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN import_quality TEXT;
ALTER TABLE subscriptions ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
DROP INDEX uq_user_source_session;
CREATE UNIQUE INDEX uq_user_source_session ON subscriptions(user_id,source_type,source_id,session_id) WHERE source_version=0;
CREATE UNIQUE INDEX uq_external_v1_target ON subscriptions(user_id,source_type,source_id) WHERE source_version=1;
