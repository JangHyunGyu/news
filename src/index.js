const HN_API = 'https://hacker-news.firebaseio.com/v0';
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

// ─────────────────────────────────────────────
//  Hacker News API
// ─────────────────────────────────────────────

async function fetchTopStories() {
  const res = await fetch(`${HN_API}/topstories.json`);
  const ids = await res.json();
  return ids.slice(0, 20);
}

async function fetchStory(id) {
  const res = await fetch(`${HN_API}/item/${id}.json`);
  return res.json();
}

async function getTop10Stories() {
  const ids = await fetchTopStories();
  const stories = await Promise.all(ids.map(fetchStory));
  return stories
    .filter(s => s && s.type === 'story' && s.title && !s.deleted && !s.dead)
    .slice(0, 10);
}

// ─────────────────────────────────────────────
//  Gemini API
// ─────────────────────────────────────────────

async function translateWithGemini(stories, apiKey) {
  const prompt = `아래 Hacker News 기사 제목 목록을 한국어로 번역하고, 각각 한 줄 요약을 제공해주세요.
반드시 JSON 배열 형식으로만 응답하세요 (다른 텍스트 없이):
[{"translated": "번역된 제목", "summary": "기사 내용 한 줄 요약"}, ...]

기사 목록:
${stories.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini API error: ${JSON.stringify(data)}`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 응답이 비어있습니다');

  return JSON.parse(text);
}

// ─────────────────────────────────────────────
//  크롤 & 저장
// ─────────────────────────────────────────────

async function crawlAndStore(env) {
  console.log('[HN News] 크롤링 시작...');

  const stories = await getTop10Stories();
  console.log(`[HN News] ${stories.length}개 기사 수집 완료`);

  const translations = await translateWithGemini(stories, env.GEMINI_API_KEY);
  console.log('[HN News] 번역 완료');

  const today = new Date().toISOString().split('T')[0];

  await env.DB.prepare('DELETE FROM news WHERE date = ?').bind(today).run();

  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const t = translations[i] || { translated: s.title, summary: '' };
    await env.DB.prepare(
      `INSERT INTO news (hn_id, date, rank, original_title, translated_title, summary, url, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        s.id,
        today,
        i + 1,
        s.title,
        t.translated,
        t.summary || '',
        s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        s.score || 0
      )
      .run();
  }

  console.log('[HN News] 저장 완료');
}

// ─────────────────────────────────────────────
//  CORS 헤더
// ─────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─────────────────────────────────────────────
//  Worker Entry Point
// ─────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /api/news - JSON API
    if (path === '/api/news') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const { results } = await env.DB.prepare(
        'SELECT * FROM news WHERE date = ? ORDER BY rank'
      )
        .bind(date)
        .all();

      return Response.json(
        { date, count: results.length, news: results },
        { headers: CORS_HEADERS }
      );
    }

    // GET / - 메인 페이지
    if (path === '' || path === '/') {
      const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArcherLab News</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0f14; color: #e2e8f0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .hero { text-align: center; padding: 40px 20px; }
    .logo { font-size: 14px; font-weight: 600; letter-spacing: 2px; color: #ff6600; text-transform: uppercase; margin-bottom: 24px; }
    h1 { font-size: 36px; font-weight: 800; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 16px; margin-bottom: 40px; line-height: 1.6; }
    .cards { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
    .card { background: #1c2030; border: 1px solid #2d3748; border-radius: 12px; padding: 24px 28px; text-decoration: none; color: inherit; width: 260px; transition: border-color 0.2s, transform 0.2s; }
    .card:hover { border-color: #ff6600; transform: translateY(-2px); }
    .card-icon { font-size: 32px; margin-bottom: 12px; }
    .card-title { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
    .card-desc { font-size: 13px; color: #94a3b8; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="hero">
    <div class="logo">ArcherLab News</div>
    <h1>매일 아침의 기술 소식</h1>
    <p>Hacker News 탑10 기사를 매일 한국어로 번역·요약합니다.<br>매일 밤 11시 자동 업데이트.</p>
    <div class="cards">
      <a class="card" href="/hn">
        <div class="card-icon">📰</div>
        <div class="card-title">HN 탑10</div>
        <div class="card-desc">오늘의 Hacker News 인기 기사 10개를 한국어로 확인하세요.</div>
      </a>
    </div>
  </div>
</body>
</html>`;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // GET /hn - HTML 페이지
    if (path === '/hn') {
      let date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      let { results } = await env.DB.prepare(
        'SELECT * FROM news WHERE date = ? ORDER BY rank'
      )
        .bind(date)
        .all();

      // 오늘 데이터가 없으면 가장 최신 날짜로 대체
      if (results.length === 0) {
        const latest = await env.DB.prepare(
          'SELECT date FROM news ORDER BY date DESC LIMIT 1'
        ).first();
        if (latest) {
          date = latest.date;
          ({ results } = await env.DB.prepare(
            'SELECT * FROM news WHERE date = ? ORDER BY rank'
          ).bind(date).all());
        }
      }

      const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HN Top 10 - ${date}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6ef; color: #333; }
    header { background: #ff6600; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
    header h1 { color: white; font-size: 18px; font-weight: 700; }
    header span { color: rgba(255,255,255,0.8); font-size: 14px; }
    main { max-width: 800px; margin: 24px auto; padding: 0 16px; }
    .card { background: white; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .rank { font-size: 12px; font-weight: 700; color: #ff6600; margin-bottom: 4px; }
    .title-ko { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .title-en a { font-size: 13px; color: #888; text-decoration: none; }
    .title-en a:hover { text-decoration: underline; }
    .summary { font-size: 14px; color: #555; margin-top: 8px; line-height: 1.5; }
    .meta { font-size: 12px; color: #aaa; margin-top: 8px; }
    .empty { text-align: center; padding: 60px 20px; color: #999; }
  </style>
</head>
<body>
  <header>
    <h1>Hacker News Top 10</h1>
    <span>${date}</span>
  </header>
  <main>
    ${results.length === 0
      ? '<div class="empty">데이터가 없습니다. 크롤링이 아직 실행되지 않았을 수 있습니다.</div>'
      : results.map(n => `
    <div class="card">
      <div class="rank">#${n.rank}</div>
      <div class="title-ko">${n.translated_title}</div>
      <div class="title-en"><a href="${n.url}" target="_blank" rel="noopener">${n.original_title}</a></div>
      ${n.summary ? `<div class="summary">${n.summary}</div>` : ''}
      <div class="meta">score: ${n.score}</div>
    </div>`).join('')}
  </main>
</body>
</html>`;

      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // /trigger - 수동 크롤 트리거 (비밀키 필요)
    if (path === '/trigger') {
      const key = request.headers.get('X-Trigger-Key');
      if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      ctx.waitUntil(crawlAndStore(env));
      return Response.json({ message: 'Crawl triggered', timestamp: new Date().toISOString() });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron 트리거 (매일 UTC 14:00 = KST 23:00)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(crawlAndStore(env));
  },
};
