ALTER TABLE subscriptions ADD COLUMN session_recovery_attempts INTEGER NOT NULL DEFAULT 0;
