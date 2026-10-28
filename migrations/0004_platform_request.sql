CREATE TABLE IF NOT EXISTS platform_request (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  response_text TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS platform_request_created_idx ON platform_request (created_at);
