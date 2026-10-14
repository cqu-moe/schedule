-- One trusted school-term check per owner, including owners without automatic capture rights.
CREATE TABLE external_term_checks (
  user_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT,
  checked_at TEXT,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','queued','running'))
);
