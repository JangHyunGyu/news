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

-- Only publish translations whose complete source was successfully processed.
-- Existing daily rows remain untouched; publication IDs survive daily replacement.
INSERT INTO articles (source_key, source_item_id, source_name, category,
  original_title, title, summary, body, original_url, translation_status,
  translation_format, published_at, modified_at)
SELECT 'hacker-news', CAST(n.hn_id AS TEXT), 'Hacker News', 'technology',
  n.original_title, n.translated_title, COALESCE(n.summary, ''), n.explanation,
  n.url, n.translation_status, COALESCE(n.translation_format, ''),
  strftime('%Y-%m-%dT%H:%M:%SZ', (
    SELECT MIN(created_at) FROM news p WHERE p.hn_id = n.hn_id
      AND p.translation_status IN ('full', 'summary')
  )), strftime('%Y-%m-%dT%H:%M:%SZ', n.created_at)
FROM news n WHERE n.translation_status IN ('full', 'summary')
  AND length(trim(COALESCE(n.explanation, ''))) > 0
  AND n.id = (SELECT p.id FROM news p WHERE p.hn_id = n.hn_id
    AND p.translation_status IN ('full', 'summary')
    AND length(trim(COALESCE(p.explanation, ''))) > 0
    ORDER BY p.created_at DESC, p.id DESC LIMIT 1)
ON CONFLICT(source_key, source_item_id) DO NOTHING;
