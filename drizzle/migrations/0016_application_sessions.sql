CREATE TABLE application_login (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE application_session (
  token_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX application_login_expiry ON application_login(expires_at);
CREATE INDEX application_session_expiry ON application_session(expires_at);
