CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hn_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  rank INTEGER NOT NULL,
  original_title TEXT NOT NULL,
  translated_title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  explanation TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_date ON news(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_date_rank ON news(date, rank);
