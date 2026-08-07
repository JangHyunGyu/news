const HN_API = 'https://hacker-news.firebaseio.com/v0';
const CENTRAL_ERROR_LOG_ENDPOINT = 'https://chatbot-api.yama5993.workers.dev/error-logs';

const KOREAN_NEWS_PROSE_SYSTEM = `당신은 IT·기술 뉴스를 비전공자도 이해할 수 있는 자연스러운 한국어로 설명하는 편집자입니다.

[한국어 원문체]
- 사용자에게 보이는 제목·요약·설명은 번역문이 아니라 처음부터 한국어로 쓴 기사처럼 자연스럽게 씁니다.
- 원문의 사실·고유명사·수치·단위·제품명·인용·전문 용어와 요구된 JSON 키·구조·고정값은 바꾸지 않습니다.
- 영어 직역 어순, 불필요한 피동·명사화·이중 완곡, 보고서 같은 상투어를 피하고 뜻이 분명한 능동 동사로 바로 씁니다.
- 문맥상 분명한 주어와 대명사는 자연스럽게 생략합니다. 같은 문장 시작·접속사·종결어미와 기계적인 열거를 반복하지 않고 문장 길이와 호흡을 내용에 맞게 조절합니다.
- 원문에 없는 사실을 보태거나 번역·요약 과정을 메타적으로 설명하지 말고, 지정된 결과만 제시합니다.`;

let _perfStatsTableReady = false;

async function ensurePerfStatsColumn(env, name, type) {
  try {
    await env.DB.prepare(`ALTER TABLE perf_stats ADD COLUMN ${name} ${type}`).run();
  } catch (error) {
    if (!/duplicate column|already exists/i.test(String(error?.message || error))) throw error;
  }
}

function getKSTDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().split('T')[0];
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// 요청당 perf_stats 1행 기록 (fire-and-forget). 별도 DB(hn-news-db) 자체 perf_stats 테이블 사용.
async function logPerfStats(env, ctx, row) {
  if (!env?.DB) return;
  const doWrite = async () => {
    if (!_perfStatsTableReady) {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS perf_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            app TEXT,
            model TEXT,
            provider_route TEXT,
            cache_key TEXT,
            cache_hit INTEGER,
            prompt_tokens INTEGER,
            cached_tokens INTEGER,
            cache_write_tokens INTEGER,
            output_tokens INTEGER,
            thought_tokens INTEGER,
            sys_chars INTEGER,
            hist_chars INTEGER,
            used_key_idx INTEGER,
            elapsed_ms INTEGER
          )
        `).run();
        await ensurePerfStatsColumn(env, 'model', 'TEXT');
        await ensurePerfStatsColumn(env, 'provider_route', 'TEXT');
        await ensurePerfStatsColumn(env, 'cache_write_tokens', 'INTEGER');
        await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_perf_stats_ts_app ON perf_stats(ts, app)').run();
        _perfStatsTableReady = true;
      } catch (e) {
        console.error('[PerfStats] Table create failed:', e.message);
        return;
      }
    }
    try {
      await env.DB.prepare(
        'INSERT INTO perf_stats (app, model, provider_route, cache_key, cache_hit, prompt_tokens, cached_tokens, cache_write_tokens, output_tokens, thought_tokens, sys_chars, hist_chars, used_key_idx, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        row.app, row.model || null, row.provider_route || null, row.cache_key, row.cache_hit,
        row.prompt_tokens, row.cached_tokens, row.cache_write_tokens || 0, row.output_tokens, row.thought_tokens,
        row.sys_chars, row.hist_chars, row.used_key_idx, row.elapsed_ms
      ).run();
    } catch (e) {
      console.warn('[PerfStats] insert error:', e.message);
    }
  };
  if (ctx?.waitUntil) ctx.waitUntil(doWrite());
  else doWrite().catch(() => {});
}

// ─────────────────────────────────────────────
//  Hacker News API
// ─────────────────────────────────────────────

async function fetchJson(url, { timeoutMs = 8000, headers } = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Upstream request failed (${response.status})`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('Upstream returned invalid JSON');
  }
}

async function fetchTopStories() {
  const ids = await fetchJson(`${HN_API}/topstories.json`);
  if (!Array.isArray(ids)) throw new Error('Hacker News returned an invalid story list');
  return ids.filter(Number.isSafeInteger).slice(0, 20);
}

async function fetchStory(id) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const story = await fetchJson(`${HN_API}/item/${id}.json`);
  return story && typeof story === 'object' && !Array.isArray(story) ? story : null;
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
//  Shared text route: Gemma 4 31B through Venice, without fallback
// ─────────────────────────────────────────────

async function translateWithDeepSeek(stories, articleContents, env, ctx) {
  const _perfStart = Date.now();
  const prompt = `당신은 IT/기술 뉴스를 비전공자도 쉽게 이해할 수 있도록 설명하는 전문가입니다.
아래 Hacker News 기사 제목과 원문 내용을 바탕으로 다음을 제공해주세요.
반드시 다음 JSON 객체 형식으로만 응답하세요 (다른 텍스트 없이):
{"items": [{
  "translated": "기사 제목을 자연스러운 한국어로 번역",
  "summary": "한 줄 핵심 요약 (40자 이내)",
  "explanation": "원문 내용을 충실히 반영하여 다음 구조로 상세 설명을 작성하세요:\\n\\n1. 이게 뭔가요?\\n이 기술/사건이 무엇인지 중학생도 이해할 수 있게 쉬운 비유나 예시로 설명합니다. 원문에서 다루는 핵심 개념과 배경을 3~4문장으로 설명하세요.\\n\\n2. 왜 화제인가요?\\nHacker News 개발자들이 왜 주목하는지, 어떤 점이 새롭거나 중요한지 원문의 구체적인 내용을 인용하며 3~4문장으로 설명하세요.\\n\\n3. 핵심 내용 정리\\n원문에서 다루는 주요 포인트를 3~5개 항목으로 정리하세요.\\n\\n4. 나에게 어떤 영향이 있나요?\\n일반인 또는 개발자에게 실질적으로 어떤 의미가 있는지 2~3문장으로 설명하세요.\\n\\n전문 용어는 반드시 쉬운 말로 풀어서 설명하세요. 원문 내용이 없는 경우 제목을 기반으로 최대한 상세히 작성하세요."
}, ...]}

기사 목록:
${stories.map((s, i) => `${i + 1}. ${s.title}\n   URL: ${s.url || 'N/A'}\n   원문 내용: ${articleContents[i] ? articleContents[i].slice(0, 2000) : '(원문 없음)'}`).join('\n\n')}`;

  if (!env?.DEEPSEEK_TEXT?.complete) {
    throw new Error('DeepSeek text service is not configured');
  }
  const result = await env.DEEPSEEK_TEXT.complete({
    appId: 'news',
    messages: [
      { role: 'system', content: KOREAN_NEWS_PROSE_SYSTEM },
      { role: 'user', content: prompt },
    ],
    responseFormat: 'json_object',
    temperature: 0.3,
    maxTokens: 24000,
  });
  const parsed = JSON.parse(result?.text || '');
  if (!Array.isArray(parsed?.items) || parsed.items.length !== stories.length) {
    throw new Error(`DeepSeek returned ${Array.isArray(parsed?.items) ? parsed.items.length : 0} of ${stories.length} news items`);
  }
  const usage = result?.usage || {};
  logPerfStats(env, ctx, {
    app: 'news',
    cache_key: null,
    cache_hit: Number(usage.prompt_cache_hit_tokens || 0) > 0 ? 1 : 0,
    prompt_tokens: usage.prompt_tokens || 0,
    cached_tokens: usage.prompt_cache_hit_tokens || 0,
    cache_write_tokens: usage.prompt_cache_write_tokens || usage.prompt_tokens_details?.cache_write_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    thought_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    sys_chars: KOREAN_NEWS_PROSE_SYSTEM.length,
    hist_chars: prompt.length,
    used_key_idx: 0,
    elapsed_ms: Date.now() - _perfStart,
    model: result?.model || null,
    provider_route: result?.provider || null,
  });

  return parsed.items;
}

// ─────────────────────────────────────────────
//  크롤 & 저장
// ─────────────────────────────────────────────

async function crawlAndStore(env, overrideDate, ctx) {
  console.log('[HN News] 크롤링 시작...');

  if (overrideDate !== undefined && overrideDate !== null && !isValidISODate(overrideDate)) {
    throw new Error('Invalid crawl date');
  }

  const stories = await getTop10Stories();
  console.log(`[HN News] ${stories.length}개 기사 수집 완료`);

  // 기사 본문 크롤링
  const articleContents = await Promise.all(
    stories.map(s => fetchArticleContent(s.url))
  );
  console.log(`[HN News] 본문 크롤링 완료 (${articleContents.filter(c => c).length}개 성공)`);

  const translations = await translateWithDeepSeek(stories, articleContents, env, ctx);
  console.log('[HN News] 번역 완료');

  // 날짜 결정: overrideDate가 있으면 그것 사용, 아니면 자동 계산
  let today;
  if (overrideDate) {
    today = overrideDate;
  } else {
    const kstHour = new Date(Date.now() + 9 * 3600000).getUTCHours();
    today = getKSTDate(kstHour >= 21 ? 1 : 0);
  }

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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function limitText(value, maxLength) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

async function forwardClientErrorToCentral(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'invalid client error payload' }, { status: 400, headers: CORS_HEADERS });
  }

  const appId = limitText(body.app_id || body.appId || 'news', 100).replace(/[^a-z0-9_.:-]/gi, '') || 'news';
  const errorType = limitText(body.error_type || body.type || 'error', 100) || 'error';
  const message = limitText(body.message || body.stack || 'Unknown client error', 500);
  if (!message) {
    return Response.json({ ok: true }, { headers: CORS_HEADERS });
  }

  await fetch(CENTRAL_ERROR_LOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId,
      userId: '',
      message: limitText('[' + errorType + '] ' + message, 500),
      stack: limitText(body.stack || '', 4000),
      url: limitText(body.url || request.headers.get('Referer') || '', 500),
      source: limitText(body.source || body.filename || '', 500),
      errorType,
      errorClass: limitText(body.error_class || body.errorClass || '', 50),
      context: body.context || null,
      extra: {
        lineno: body.lineno ?? body.line ?? 0,
        colno: body.colno ?? body.column ?? 0,
        userAgent: request.headers.get('User-Agent') || '',
      },
    }),
  }).catch(() => null);

  return Response.json({ ok: true }, { headers: CORS_HEADERS });
}

async function forwardServerErrorToCentral(request, error, context = {}) {
  const message = error?.message || String(error || 'Unknown server error');
  await fetch(CENTRAL_ERROR_LOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: 'news-server',
      userId: '',
      message: limitText('[server] ' + message, 500),
      stack: limitText(error?.stack || '', 4000),
      url: limitText(request?.url || '', 500),
      source: limitText(context.path || 'news-worker', 500),
      errorType: 'server_error',
      errorClass: limitText(error?.name || '', 50),
      context,
      extra: {
        userAgent: request?.headers?.get?.('User-Agent') || '',
      },
    }),
  }).catch(() => null);
}

// ─────────────────────────────────────────────
//  Worker Entry Point
// ─────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === '/api/client-errors' && request.method === 'POST') {
      return forwardClientErrorToCentral(request);
    }

    // GET /api/news - JSON API
    if (path === '/api/news') {
      if (request.method !== 'GET') {
        return Response.json(
          { error: 'Method Not Allowed' },
          { status: 405, headers: { ...CORS_HEADERS, Allow: 'GET' } }
        );
      }
      const requestedDate = url.searchParams.get('date');
      if (requestedDate !== null && !isValidISODate(requestedDate)) {
        return Response.json(
          { error: 'Invalid date. Use YYYY-MM-DD.' },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      let date = requestedDate || getKSTDate();
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
    // ?date=YYYY-MM-DD 로 특정 날짜 지정 가능
    if (path === '/trigger') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      const key = request.headers.get('X-Trigger-Key');
      if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      const dateParam = url.searchParams.get('date') || null;
      if (dateParam !== null && !isValidISODate(dateParam)) {
        return Response.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, { status: 400 });
      }
      ctx.waitUntil(crawlAndStore(env, dateParam, ctx));
      return Response.json({ message: 'Crawl triggered', date: dateParam || 'auto', timestamp: new Date().toISOString() });
    }

    return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('[HN News] worker error:', err);
      if (ctx?.waitUntil) {
        ctx.waitUntil(forwardServerErrorToCentral(request, err, { path, method: request.method }));
      } else {
        await forwardServerErrorToCentral(request, err, { path, method: request.method });
      }
      return Response.json(
        { error: 'Internal Server Error' },
        { status: 500, headers: CORS_HEADERS }
      );
    }
  },

  // Cron 트리거 (매일 UTC 14:00 = KST 23:00)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      crawlAndStore(env, null, ctx).catch(async (err) => {
        console.error('[HN News] 크롤링 실패:', err);
        try {
          await fetch('https://chatbot-api.yama5993.workers.dev/error-logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              appId: 'news-cron',
              userId: '',
              message: (err.message || 'Cron crawl failed').substring(0, 500),
              stack: (err.stack || '').substring(0, 2000),
              url: 'scheduled:' + event.cron,
            }),
          });
        } catch (_) {}
      })
    );
  },
};
