CREATE UNIQUE INDEX uq_personal_subscription_user
  ON subscriptions(user_id) WHERE source_type='personal';

CREATE TABLE personal_subscription_views (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN
    ('personal_all','personal_courses','personal_exams')),
  source_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(subscription_id,source_type)
);

ALTER TABLE calendar_links ADD COLUMN personal_view_type TEXT
  CHECK(personal_view_type IS NULL OR personal_view_type IN
    ('personal_all','personal_courses','personal_exams'));

CREATE INDEX idx_calendar_links_personal_view
  ON calendar_links(subscription_id,personal_view_type);

CREATE TABLE personal_subscription_migration_backups (
  user_id TEXT PRIMARY KEY NOT NULL,
  subscriptions_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  setup_json TEXT,
  migrated_at TEXT NOT NULL
);
