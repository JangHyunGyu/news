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

  // 쉬운 설명 일괄 생성 (번역된 데이터 기반)
  const explanations = await Promise.all(
    stories.map((s, i) => {
      const t = translations[i] || { translated: s.title, summary: '' };
      return generateExplanation(
        { original_title: s.title, translated_title: t.translated, summary: t.summary || '' },
        env.GEMINI_API_KEY
      ).catch(() => null);
    })
  );
  console.log('[HN News] 쉬운 설명 생성 완료');

  const today = new Date().toISOString().split('T')[0];

  await env.DB.prepare('DELETE FROM news WHERE date = ?').bind(today).run();

  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const t = translations[i] || { translated: s.title, summary: '' };
    const exp = explanations[i] ? JSON.stringify(explanations[i]) : null;
    await env.DB.prepare(
      `INSERT INTO news (hn_id, date, rank, original_title, translated_title, summary, url, score, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        s.id,
        today,
        i + 1,
        s.title,
        t.translated,
        t.summary || '',
        s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        s.score || 0,
        exp
      )
      .run();
  }

  console.log('[HN News] 저장 완료');
}

// ─────────────────────────────────────────────
//  AI 상세 설명 (비전공자용, D1 캐싱)
// ─────────────────────────────────────────────

async function generateExplanation(item, apiKey) {
  const prompt = `다음 IT/기술 뉴스를 비전공자도 이해할 수 있도록 쉽게 설명해주세요.

기사 제목(원문): ${item.original_title}
번역된 제목: ${item.translated_title}
한줄 요약: ${item.summary || '없음'}

다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "simple_title": "초등학생도 이해할 수 있는 한 문장 제목",
  "explanation": "이 기사가 왜 중요한지, 어떤 내용인지 비전공자도 이해할 수 있도록 3~4문장으로 쉽게 설명",
  "keywords": ["핵심 키워드1 (쉬운 설명)", "핵심 키워드2 (쉬운 설명)"]
}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
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
        'SELECT * FROM news WHERE date = ? ORDER BY score DESC'
      )
        .bind(date)
        .all();

      return Response.json(
        { date, count: results.length, news: results },
        { headers: CORS_HEADERS }
      );
    }

    // GET /api/explain?hn_id=xxx - AI 상세 설명 (캐싱)
    if (path === '/api/explain') {
      const hnId = url.searchParams.get('hn_id');
      if (!hnId) return new Response('hn_id required', { status: 400 });

      const row = await env.DB.prepare(
        'SELECT * FROM news WHERE hn_id = ? ORDER BY id DESC LIMIT 1'
      ).bind(hnId).first();
      if (!row) return new Response('Not found', { status: 404 });

      // 캐시된 설명이 있으면 바로 반환
      if (row.explanation) {
        return Response.json(JSON.parse(row.explanation), { headers: CORS_HEADERS });
      }

      // Gemini로 설명 생성
      const result = await generateExplanation(row, env.GEMINI_API_KEY);
      await env.DB.prepare('UPDATE news SET explanation = ? WHERE hn_id = ?')
        .bind(JSON.stringify(result), hnId).run();

      return Response.json(result, { headers: CORS_HEADERS });
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

    // 정적 파일 (public/) 서빙
    return env.ASSETS.fetch(request);
  },

  // Cron 트리거 (매일 UTC 14:00 = KST 23:00)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(crawlAndStore(env));
  },
};
