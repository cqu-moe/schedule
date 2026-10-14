-- Pending enqueue receipts survive subscription deletion and target expiration.
-- Accepted sends remove their receipt; failed sends consume it atomically once.
CREATE TABLE external_manual_refresh_reservations (
  run_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  quota_date TEXT NOT NULL
);
