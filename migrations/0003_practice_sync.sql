CREATE TABLE IF NOT EXISTS practice_sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS practice_sessions_user_idx ON practice_sessions (user_id, updated_at);
