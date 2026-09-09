import { fetchArticleContent, translateArticle } from './articles.mjs';

export async function ensureTranslationSchema(env) {
  for (const column of ['explanation TEXT', 'original_content TEXT', "translation_status TEXT DEFAULT 'legacy'", 'translation_model TEXT', 'translation_format TEXT']) {
    try { await env.DB.prepare(`ALTER TABLE news ADD COLUMN ${column}`).run(); }
    catch (error) { if (!/duplicate column|already exists/i.test(String(error?.message || error))) throw error; }
  }
}

export async function prepareNews(stories, complete, fetchImpl = fetch) {
  const results = new Array(stories.length);
  let next = 0;
  async function run() {
    while (next < stories.length) {
      const index = next++;
      const story = stories[index];
      let source = '';
      try {
        source = story.original_content?.trim() || await fetchArticleContent(story, fetchImpl);
        const translation = await translateArticle(story, source, complete);
        results[index] = { ...translation, original_content: source, translation_status: 'full' };
      } catch (error) {
        console.error('[Article translation failed]', story.id, error.message);
        const message = source
          ? '원문 전체를 번역하지 못했습니다. 원문 링크에서 기사를 확인해 주세요.'
          : '원문 본문을 불러오지 못했습니다. 원문 링크에서 기사를 확인해 주세요.';
        results[index] = {
          translated: story.title, summary: message, explanation: message,
          original_content: source, translation_status: source ? 'failed' : 'unavailable', models: '', format: '',
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, stories.length) }, run));
  return results;
}

export async function storeNews(env, date, stories, translations, refresh = false) {
  await ensureTranslationSchema(env);
  const statements = [];
  if (!refresh) statements.push(env.DB.prepare('DELETE FROM news WHERE date = ?').bind(date));
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i], translated = translations[i];
    if (refresh) {
      // 재번역 실패 시 이미 저장된 전체 번역 보존
      statements.push(env.DB.prepare(`UPDATE news SET translated_title = ?, summary = ?, explanation = ?,
        original_content = ?, translation_status = ?, translation_model = ?, translation_format = ? WHERE date = ? AND hn_id = ?
        AND (COALESCE(translation_status, '') != 'full' OR ? = 'full')`).bind(
        translated.translated, translated.summary, translated.explanation, translated.original_content,
        translated.translation_status, translated.models, translated.format || '', date, story.id, translated.translation_status,
      ));
    } else {
      statements.push(env.DB.prepare(`INSERT INTO news
        (hn_id, date, rank, original_title, translated_title, summary, explanation, url, score, original_content, translation_status, translation_model, translation_format)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        story.id, date, i + 1, story.title, translated.translated, translated.summary, translated.explanation,
        story.url || `https://news.ycombinator.com/item?id=${story.id}`, story.score || 0,
        translated.original_content, translated.translation_status, translated.models, translated.format || '',
      ));
    }
  }
  if (statements.length) await env.DB.batch(statements);
}
