const HN_API = 'https://hacker-news.firebaseio.com/v0';
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

function getKSTDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().split('T')[0];
}

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

// 기사 본문 크롤링 (텍스트 추출)
async function fetchArticleContent(url) {
  if (!url || url.includes('news.ycombinator.com')) return '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HNBot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    // HTML 태그 제거, 스크립트/스타일 제거
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 최대 3000자로 제한
    return cleaned.slice(0, 3000);
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
//  Gemini API
// ─────────────────────────────────────────────

async function translateWithGemini(stories, articleContents, apiKey) {
  const prompt = `당신은 IT/기술 뉴스를 비전공자도 쉽게 이해할 수 있도록 설명하는 전문가입니다.
아래 Hacker News 기사 제목과 원문 내용을 바탕으로 다음을 제공해주세요.
반드시 JSON 배열 형식으로만 응답하세요 (다른 텍스트 없이):
[{
  "translated": "기사 제목을 자연스러운 한국어로 번역",
  "summary": "한 줄 핵심 요약 (40자 이내)",
  "explanation": "원문 내용을 충실히 반영하여 다음 구조로 상세 설명을 작성하세요:\\n\\n1. 이게 뭔가요?\\n이 기술/사건이 무엇인지 중학생도 이해할 수 있게 쉬운 비유나 예시로 설명합니다. 원문에서 다루는 핵심 개념과 배경을 3~4문장으로 설명하세요.\\n\\n2. 왜 화제인가요?\\nHacker News 개발자들이 왜 주목하는지, 어떤 점이 새롭거나 중요한지 원문의 구체적인 내용을 인용하며 3~4문장으로 설명하세요.\\n\\n3. 핵심 내용 정리\\n원문에서 다루는 주요 포인트를 3~5개 항목으로 정리하세요.\\n\\n4. 나에게 어떤 영향이 있나요?\\n일반인 또는 개발자에게 실질적으로 어떤 의미가 있는지 2~3문장으로 설명하세요.\\n\\n전문 용어는 반드시 쉬운 말로 풀어서 설명하세요. 원문 내용이 없는 경우 제목을 기반으로 최대한 상세히 작성하세요."
}, ...]

기사 목록:
${stories.map((s, i) => `${i + 1}. ${s.title}\n   URL: ${s.url || 'N/A'}\n   원문 내용: ${articleContents[i] ? articleContents[i].slice(0, 2000) : '(원문 없음)'}`).join('\n\n')}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 1,
          thinkingConfig: {
            thinkingLevel: 'high',
          },
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

  // 기사 본문 크롤링
  const articleContents = await Promise.all(
    stories.map(s => fetchArticleContent(s.url))
  );
  console.log(`[HN News] 본문 크롤링 완료 (${articleContents.filter(c => c).length}개 성공)`);

  const translations = await translateWithGemini(stories, articleContents, env.GEMINI_API_KEY);
  console.log('[HN News] 번역 완료');

  const today = getKSTDate(1);  // 23시 크론 → 다음 날 날짜로 저장

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
      let date = url.searchParams.get('date') || getKSTDate();
      let { results } = await env.DB.prepare(
        'SELECT * FROM news WHERE date = ? ORDER BY score DESC'
      )
        .bind(date)
        .all();

      // 해당 날짜 데이터가 없으면 가장 가까운 이전 날짜로 대체
      if (results.length === 0) {
        const nearest = await env.DB.prepare(
          'SELECT date FROM news WHERE date <= ? ORDER BY date DESC LIMIT 1'
        ).bind(date).first();
        if (nearest) {
          date = nearest.date;
          ({ results } = await env.DB.prepare(
            'SELECT * FROM news WHERE date = ? ORDER BY score DESC'
          ).bind(date).all());
        }
      }

      // 이전/다음 날짜 조회
      const prevDate = await env.DB.prepare(
        'SELECT date FROM news WHERE date < ? GROUP BY date ORDER BY date DESC LIMIT 1'
      ).bind(date).first();
      const nextDate = await env.DB.prepare(
        'SELECT date FROM news WHERE date > ? GROUP BY date ORDER BY date ASC LIMIT 1'
      ).bind(date).first();

      return Response.json(
        {
          date,
          count: results.length,
          news: results,
          prevDate: prevDate?.date || null,
          nextDate: nextDate?.date || null,
        },
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
