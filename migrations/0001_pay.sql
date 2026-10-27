CREATE TABLE IF NOT EXISTS wallet (
  user_id TEXT PRIMARY KEY NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pay_order (
  out_trade_no TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  trade_no TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE INDEX IF NOT EXISTS pay_order_user_idx ON pay_order (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pay_notify (
  id TEXT PRIMARY KEY NOT NULL,
  out_trade_no TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
