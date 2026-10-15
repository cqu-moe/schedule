-- Only complete generations are visible. Staging rows can survive retries.
CREATE TABLE external_directory_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  active_run_id TEXT,
  published_run_id TEXT,
  next_due_at INTEGER NOT NULL DEFAULT 0,
  observed_session_id TEXT,
  observed_at INTEGER NOT NULL DEFAULT 0,
  foreground_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO external_directory_state (id) VALUES (1);

CREATE TABLE external_directory_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  phase INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  session_name TEXT,
  departments_json TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  dispatch_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE external_directory_items (
  run_id TEXT NOT NULL REFERENCES external_directory_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  course_code TEXT NOT NULL DEFAULT '',
  collected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id,kind,id)
);
CREATE INDEX external_directory_pending ON external_directory_items(run_id,kind,collected,id);

-- Course/class associations are fetched with an explicit course ID and term;
-- the bulk class directory must never be joined on a course's display name.
CREATE TABLE external_directory_course_cache (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id,session_id,course_id)
);
