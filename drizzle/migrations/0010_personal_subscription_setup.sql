CREATE TABLE personal_subscription_setup (
  user_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','existing')),
  subscription_ids TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending','sending','sent','failed')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_personal_setup_dispatch
  ON personal_subscription_setup (dispatch_status, lease_until);

INSERT INTO personal_subscription_setup
  (user_id,status,subscription_ids,run_id,dispatch_status,created_at,updated_at)
SELECT DISTINCT user_id,'existing','[]',NULL,'sent',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM subscriptions;
