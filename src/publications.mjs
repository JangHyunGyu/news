export const CATEGORIES = Object.freeze({
  technology: 'IT', science: '과학', economy: '경제', world: '국제',
  society: '사회', politics: '정치', culture: '문화', sports: '스포츠',
});

export function publicationStatement(db, article, now = new Date().toISOString()) {
  const required = ['source_key', 'source_item_id', 'source_name', 'category', 'original_title', 'title', 'body', 'original_url'];
  for (const key of required) {
    if (typeof article[key] !== 'string' || !article[key].trim()) throw new Error(`Missing publication field: ${key}`);
  }
  if (!Object.hasOwn(CATEGORIES, article.category)) throw new Error('Unsupported category');
  if (!['full', 'summary'].includes(article.translation_status)) throw new Error('Incomplete translation cannot be published');
  const source = new URL(article.original_url);
  if (!['https:', 'http:'].includes(source.protocol)) throw new Error('Invalid publication source URL');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid publication timestamp');
  const timestamp = new Date(now).toISOString();
  return db.prepare(`INSERT INTO articles
    (source_key, source_item_id, source_name, category, original_title, title, summary,
     body, original_url, translation_status, translation_format, published_at, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_item_id) DO UPDATE SET
      source_name = excluded.source_name, category = excluded.category,
      original_title = excluded.original_title, title = excluded.title,
      summary = excluded.summary, body = excluded.body, original_url = excluded.original_url,
      translation_status = excluded.translation_status, translation_format = excluded.translation_format,
      modified_at = CASE WHEN articles.title IS NOT excluded.title OR articles.body IS NOT excluded.body
        OR articles.summary IS NOT excluded.summary OR articles.original_url IS NOT excluded.original_url
        OR articles.source_name IS NOT excluded.source_name OR articles.category IS NOT excluded.category
        THEN excluded.modified_at ELSE articles.modified_at END`).bind(
    article.source_key.trim(), article.source_item_id.trim(), article.source_name.trim(), article.category,
    article.original_title, article.title, article.summary || '', article.body, source.href,
    article.translation_status, article.translation_format || '', timestamp, timestamp,
  );
}

// Source adapters share this entry point; callers must provide a verified full translation or summary.
export async function publishArticles(env, articles, now) {
  if (!articles.length) return;
  const statements = articles.map(article => publicationStatement(env.DB, article, now));
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.batch(statements.slice(offset, offset + 50));
  }
}

export function hnPublication(story, translated) {
  return {
    source_key: 'hacker-news', source_item_id: String(story.id), source_name: 'Hacker News',
    category: 'technology', original_title: story.title, title: translated.translated,
    summary: translated.summary || '', body: translated.explanation,
    original_url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
    translation_status: translated.translation_status, translation_format: translated.format || '',
  };
}

export async function readEdition(db, requestedDate, { exact = false } = {}) {
  const date = exact ? requestedDate : (await db.prepare(
    'SELECT MAX(date) AS date FROM news WHERE date <= ?'
  ).bind(requestedDate).first())?.date;
  if (!date) return null;
  const { results: news } = await db.prepare(`SELECT n.*, a.id AS article_id FROM news n
    LEFT JOIN articles a ON a.source_key = 'hacker-news' AND a.source_item_id = CAST(n.hn_id AS TEXT)
    WHERE n.date = ? ORDER BY n.rank ASC`).bind(date).all();
  if (!news.length) return null;
  const adjacent = await db.prepare(`SELECT
    (SELECT MAX(date) FROM news WHERE date < ?) AS prevDate,
    (SELECT MIN(date) FROM news WHERE date > ?) AS nextDate`).bind(date, date).first();
  return { date, count: news.length, news: news.map(({ original_content, ...row }) => row), ...adjacent };
}
