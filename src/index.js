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
  const prompt = `아래 Hacker News 기사 제목 목록을 한국어로 번역하고, 각각 한 줄 요약과 2~3문장 상세 설명을 제공해주세요.
반드시 JSON 배열 형식으로만 응답하세요 (다른 텍스트 없이):
[{"translated": "번역된 제목", "summary": "기사 내용 한 줄 요약", "explanation": "이 기사가 왜 중요한지, 어떤 내용인지 비개발자도 이해할 수 있게 2~3문장으로 쉽게 설명"}, ...]

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
      `INSERT INTO news (hn_id, date, rank, original_title, translated_title, summary, explanation, url, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        s.id,
        today,
        i + 1,
        s.title,
        t.translated,
        t.summary || '',
        t.explanation || '',
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
      let date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      let { results } = await env.DB.prepare(
        'SELECT * FROM news WHERE date = ? ORDER BY score DESC'
      )
        .bind(date)
        .all();

      // 해당 날짜 데이터가 없으면 가장 최신 날짜로 대체
      if (results.length === 0 && !url.searchParams.get('date')) {
        const latest = await env.DB.prepare(
          'SELECT date FROM news ORDER BY date DESC LIMIT 1'
        ).first();
        if (latest) {
          date = latest.date;
          ({ results } = await env.DB.prepare(
            'SELECT * FROM news WHERE date = ? ORDER BY score DESC'
          ).bind(date).all());
        }
      }

      return Response.json(
        { date, count: results.length, news: results },
        { headers: CORS_HEADERS }
      );
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
