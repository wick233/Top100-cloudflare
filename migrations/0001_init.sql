CREATE TABLE IF NOT EXISTS bars (
  ticker TEXT NOT NULL,
  interval TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ticker, interval, date)
);
CREATE INDEX IF NOT EXISTS bars_date_idx ON bars (ticker, interval, date);

CREATE TABLE IF NOT EXISTS cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expiry_idx ON cache (expires_at);
