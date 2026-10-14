CREATE TABLE external_manual_refresh_usage (
  user_id TEXT NOT NULL,
  quota_date TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, quota_date)
);
