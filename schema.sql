CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hn_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  rank INTEGER NOT NULL,
  original_title TEXT NOT NULL,
  translated_title TEXT NOT NULL,
  summary TEXT,
  explanation TEXT,
  original_content TEXT,
  translation_status TEXT DEFAULT 'legacy',
  translation_model TEXT,
  translation_format TEXT,
  url TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_date ON news(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_date_rank ON news(date, rank);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  category TEXT NOT NULL,
  original_title TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  original_url TEXT NOT NULL,
  translation_status TEXT NOT NULL,
  translation_format TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  UNIQUE(source_key, source_item_id)
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category, published_at DESC, id DESC);
