import { prepareNews, storeNews } from './pipeline.mjs';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const CENTRAL_ERROR_LOG_ENDPOINT = 'https://chatbot-api.yama5993.workers.dev/error-logs';

const KOREAN_NEWS_PROSE_SYSTEM = `당신은 IT를 처음 접하는 독자에게 기사의 원문 전체를 쉽게 풀어 전달하는 한국어 번역가입니다.

[한국어 원문체]
- 원문의 모든 문장에 담긴 내용과 논리 전개를 빠짐없이 옮깁니다. 어려운 문장은 여러 문장으로 나누어 풀고, 긴 기사를 짧은 요약으로 대체하지 않습니다.
- 원문의 문단·소제목·인용·목록·말투와 주장의 강도를 유지하되, 독자가 이해하는 데 필요한 쉬운 설명을 덧붙입니다. 코드는 그대로 남기고 무엇을 하는 코드인지 설명합니다.
- 독자가 서버·브라우저·암호화·오픈소스 같은 용어도 모를 수 있다고 생각합니다. 전문용어는 처음 나올 때 쉬운 뜻과 쓰임을 설명하고, 다른 전문용어만으로 정의하지 않습니다. 약어의 영어 이름만 늘어놓지 않습니다.
- 개념을 설명한 다음 기사에서 그 개념이 어떤 역할을 하는지 연결합니다. 원인과 결과 사이의 과정을 생략하지 않습니다. 예시는 도움이 될 때만 짧고 구체적으로 들고, 실제 기사 속 사건처럼 말하지 않습니다.
- 원문의 사실·고유명사·수치·단위·제품명·인용·전문 용어와 요구된 JSON 키·구조·고정값은 바꾸지 않습니다.
- 영어 직역 어순, 불필요한 피동·명사화·이중 완곡, 보고서 같은 상투어를 피하고 뜻이 분명한 능동 동사로 바로 씁니다.
- 문맥상 분명한 주어와 대명사는 자연스럽게 생략합니다. 같은 문장 시작·접속사·종결어미와 기계적인 열거를 반복하지 않고 문장 길이와 호흡을 내용에 맞게 조절합니다.
- 보충 설명은 널리 알려진 기초 지식으로 한정합니다. 원문에 없는 사건·수치·인용·사람들의 반응을 만들지 않습니다. 글쓴이의 주장, 확인된 사실, 이해를 돕는 예시와 예상되는 영향을 구별합니다.
- 기사별로 필요한 내용을 충분히 설명하되 같은 정의·비유·결론을 반복하지 않습니다. 독자를 가르치듯 훈계하거나 유치한 말투를 쓰지 않고, 자연스러운 존댓말로 씁니다. 지정된 JSON 결과만 제시합니다.`;

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

async function completeNewsTranslation(prompt, env, ctx) {
  if (!env?.DEEPSEEK_TEXT?.complete) throw new Error('News text service is not configured');
  const started = Date.now();
  const result = await env.DEEPSEEK_TEXT.complete({
    appId: 'news',
    messages: [
      { role: 'system', content: KOREAN_NEWS_PROSE_SYSTEM },
      { role: 'user', content: prompt },
    ],
    responseFormat: 'json_object', temperature: 0.3, maxTokens: 8192,
  });
  const usage = result?.usage || {};
  logPerfStats(env, ctx, {
    app: 'news', cache_key: null,
    cache_hit: Number(usage.prompt_cache_hit_tokens || 0) > 0 ? 1 : 0,
    prompt_tokens: usage.prompt_tokens || 0,
    cached_tokens: usage.prompt_cache_hit_tokens || 0,
    cache_write_tokens: usage.prompt_cache_write_tokens || usage.prompt_tokens_details?.cache_write_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    thought_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    sys_chars: KOREAN_NEWS_PROSE_SYSTEM.length, hist_chars: prompt.length,
    used_key_idx: 0, elapsed_ms: Date.now() - started,
    model: result?.model || null,
    provider_route: result?.providerRoute || result?.provider || null,
  });
  return result;
}

async function crawlAndStore(env, overrideDate, ctx, refresh = false) {
  if (overrideDate !== undefined && overrideDate !== null && !isValidISODate(overrideDate)) throw new Error('Invalid crawl date');
  const kstHour = new Date(Date.now() + 9 * 3600000).getUTCHours();
  const date = overrideDate || getKSTDate(kstHour >= 21 ? 1 : 0);
  let stories;
  if (refresh) {
    const { results } = await env.DB.prepare('SELECT * FROM news WHERE date = ? ORDER BY rank').bind(date).all();
    if (!results.length) throw new Error('No articles to refresh for this date');
    stories = await Promise.all(results.map(async row => {
      const story = { id: row.hn_id, title: row.original_title, url: row.url, score: row.score, original_content: row.original_content || '' };
      if (!story.original_content && new URL(story.url).hostname === 'news.ycombinator.com') {
        const original = await fetchStory(story.id);
        if (original?.text) story.text = original.text;
      }
      return story;
    }));
  } else {
    stories = await getTop10Stories();
    if (!stories.length) throw new Error('No Hacker News articles available');
  }
  const translations = await prepareNews(stories, prompt => completeNewsTranslation(prompt, env, ctx));
  if (!translations.some(item => item.translation_status === 'full')) throw new Error('No complete article translations; existing news preserved');
  await storeNews(env, date, stories, translations, refresh);
  console.log('[HN News] Full translations stored', date, translations.filter(item => item.translation_status === 'full').length);
}

const NOINDEX_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
};

const CORS_HEADERS = {
  ...NOINDEX_HEADERS,
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
        return new Response('Method Not Allowed', { status: 405, headers: { ...NOINDEX_HEADERS, Allow: 'POST' } });
      }
      const key = request.headers.get('X-Trigger-Key');
      if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
        return new Response('Unauthorized', { status: 401, headers: NOINDEX_HEADERS });
      }
      const dateParam = url.searchParams.get('date') || null;
      if (dateParam !== null && !isValidISODate(dateParam)) {
        return Response.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, { status: 400, headers: NOINDEX_HEADERS });
      }
      await crawlAndStore(env, dateParam, ctx, url.searchParams.get('refresh') === '1');
      return Response.json(
        { message: 'Crawl completed', date: dateParam || 'auto', timestamp: new Date().toISOString() },
        { headers: NOINDEX_HEADERS }
      );
    }

    return new Response('Not Found', { status: 404, headers: NOINDEX_HEADERS });
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
