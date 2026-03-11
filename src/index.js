const HN_API = 'https://hacker-news.firebaseio.com/v0';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

// ─────────────────────────────────────────────
//  Hacker News API
// ─────────────────────────────────────────────

async function fetchTopStories() {
  const res = await fetch(`${HN_API}/topstories.json`);
  const ids = await res.json();
  return ids.slice(0, 20); // 여유분 포함해서 20개 가져오기
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

  // 오늘 데이터 초기화
  await env.DB.prepare('DELETE FROM news WHERE date = ?').bind(today).run();

  // 신규 데이터 삽입
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
//  HTML 렌더러
// ─────────────────────────────────────────────

function renderHTML(news, date) {
  const isToday = date === new Date().toISOString().split('T')[0];
  const displayDate = new Date(date + 'T00:00:00').toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });

  const items = news.length
    ? news
        .map(
          (item, i) => `
        <article class="news-card" style="--i:${i}">
          <div class="news-rank">${item.rank}</div>
          <div class="news-body">
            <a class="news-title" href="${item.url}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(item.translated_title)}
            </a>
            <p class="news-summary">${escapeHtml(item.summary || '')}</p>
            <div class="news-meta">
              <span class="news-original" title="원문 제목">${escapeHtml(item.original_title)}</span>
              <span class="news-score">▲ ${item.score}</span>
              <a class="news-hn-link" href="https://news.ycombinator.com/item?id=${item.hn_id}" target="_blank" rel="noopener">HN 토론</a>
            </div>
          </div>
        </article>`
        )
        .join('')
    : `<div class="empty">
        <p>아직 오늘의 뉴스가 없습니다.</p>
        <p class="empty-sub">매일 밤 11시(KST)에 자동으로 업데이트됩니다.</p>
      </div>`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HN 탑10 | news.archerlab.dev</title>
  <meta name="description" content="Hacker News 탑10 기사를 매일 한국어로 번역해서 보여주는 서비스입니다." />
  <meta property="og:title" content="HN 탑10 — 오늘의 해커뉴스 한국어 요약" />
  <meta property="og:description" content="Hacker News 탑10 기사를 매일 한국어로 번역해서 보여주는 서비스입니다." />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://news.archerlab.dev/hn" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Pretendard:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0d0f14;
      --surface: #141720;
      --surface2: #1c2030;
      --border: #252a3a;
      --text: #e8eaf0;
      --text-muted: #7a82a0;
      --text-dim: #4a5068;
      --accent: #f6851b;
      --accent-dim: rgba(246,133,27,0.15);
      --link: #60a5fa;
      --score: #34d399;
    }

    html { scroll-behavior: smooth; }

    body {
      font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Header ── */
    header {
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      background: rgba(13,15,20,0.92);
      backdrop-filter: blur(12px);
      z-index: 10;
    }

    .header-logo {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      text-decoration: none;
    }

    .logo-icon {
      width: 28px;
      height: 28px;
      background: var(--accent);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      font-weight: 700;
      color: #fff;
      font-family: 'IBM Plex Mono', monospace;
    }

    .logo-text {
      font-size: 1rem;
      font-weight: 700;
      color: var(--text);
      letter-spacing: -0.02em;
    }

    .header-back {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-decoration: none;
      transition: color 0.2s;
    }
    .header-back:hover { color: var(--text); }

    /* ── Hero ── */
    .hero {
      padding: 2.5rem 1.5rem 2rem;
      max-width: 760px;
      margin: 0 auto;
      width: 100%;
    }

    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: var(--accent-dim);
      border: 1px solid rgba(246,133,27,0.3);
      border-radius: 20px;
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      color: var(--accent);
      font-weight: 600;
      margin-bottom: 1rem;
      font-family: 'IBM Plex Mono', monospace;
    }

    .hero-title {
      font-size: clamp(1.6rem, 4vw, 2.2rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.2;
      margin-bottom: 0.5rem;
    }

    .hero-date {
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    /* ── News List ── */
    .news-list {
      max-width: 760px;
      margin: 0 auto;
      width: 100%;
      padding: 0 1.5rem 3rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .news-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.25rem 1.25rem 1rem;
      display: flex;
      gap: 1rem;
      transition: border-color 0.2s, background 0.2s;
      animation: fadeUp 0.4s ease both;
      animation-delay: calc(var(--i) * 0.05s);
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .news-card:hover {
      border-color: rgba(246,133,27,0.4);
      background: var(--surface2);
    }

    .news-rank {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 1.4rem;
      font-weight: 700;
      color: var(--text-dim);
      min-width: 2rem;
      text-align: center;
      line-height: 1.4;
      padding-top: 0.1rem;
    }

    .news-card:nth-child(1) .news-rank { color: var(--accent); }
    .news-card:nth-child(2) .news-rank { color: #e2a94e; }
    .news-card:nth-child(3) .news-rank { color: #a0aec0; }

    .news-body { flex: 1; min-width: 0; }

    .news-title {
      display: block;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
      line-height: 1.5;
      margin-bottom: 0.4rem;
      word-break: keep-all;
      transition: color 0.2s;
    }
    .news-title:hover { color: var(--link); }

    .news-summary {
      font-size: 0.85rem;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 0.6rem;
      word-break: keep-all;
    }

    .news-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
      font-size: 0.75rem;
    }

    .news-original {
      color: var(--text-dim);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.7rem;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .news-score {
      color: var(--score);
      font-weight: 600;
      font-family: 'IBM Plex Mono', monospace;
      white-space: nowrap;
    }

    .news-hn-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
      border: 1px solid rgba(246,133,27,0.3);
      border-radius: 4px;
      padding: 0.1rem 0.4rem;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .news-hn-link:hover { background: var(--accent-dim); }

    /* ── Empty ── */
    .empty {
      text-align: center;
      padding: 4rem 1rem;
      color: var(--text-muted);
    }
    .empty-sub { font-size: 0.85rem; margin-top: 0.5rem; color: var(--text-dim); }

    /* ── Footer ── */
    footer {
      margin-top: auto;
      border-top: 1px solid var(--border);
      padding: 1.25rem 1.5rem;
      text-align: center;
      font-size: 0.8rem;
      color: var(--text-dim);
    }
    footer a { color: var(--text-muted); text-decoration: none; }
    footer a:hover { color: var(--text); }

    @media (max-width: 480px) {
      .news-original { display: none; }
      .hero { padding: 1.5rem 1rem 1.5rem; }
      .news-list { padding: 0 1rem 2rem; }
    }
  </style>
</head>
<body>

<header>
  <a class="header-logo" href="/">
    <div class="logo-icon">HN</div>
    <span class="logo-text">HN 탑10</span>
  </a>
  <a class="header-back" href="https://archerlab.dev">← ArcherLab</a>
</header>

<main>
  <section class="hero">
    <div class="hero-badge">
      <span>●</span>
      ${isToday ? '오늘 업데이트' : '아카이브'}
    </div>
    <h1 class="hero-title">오늘의 Hacker News 탑10</h1>
    <p class="hero-date">${displayDate}</p>
  </section>

  <section class="news-list" aria-label="뉴스 목록">
    ${items}
  </section>
</main>

<footer>
  <p>
    매일 밤 11시(KST) 자동 업데이트 ·
    원문 출처 <a href="https://news.ycombinator.com" target="_blank" rel="noopener">Hacker News</a> ·
    <a href="https://archerlab.dev">ArcherLab</a>
  </p>
</footer>

</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────
//  Worker Entry Point
// ─────────────────────────────────────────────

export default {
  // HTTP 요청 처리
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const path = url.pathname.replace(/\/$/, '') || '/';

    // /hn/api/news - JSON API
    if (path === '/hn/api/news') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const { results } = await env.DB.prepare(
        'SELECT * FROM news WHERE date = ? ORDER BY rank'
      )
        .bind(date)
        .all();

      return Response.json(
        { date, count: results.length, news: results },
        { headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // /hn/trigger - 수동 크롤 트리거 (비밀키 필요)
    if (path === '/hn/trigger') {
      const key = request.headers.get('X-Trigger-Key');
      if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      ctx.waitUntil(crawlAndStore(env));
      return Response.json({ message: 'Crawl triggered', timestamp: new Date().toISOString() });
    }

    // /hn - Hacker News 메인 페이지
    if (path === '/hn') {
      const today = new Date().toISOString().split('T')[0];
      const date = url.searchParams.get('date') || today;

      const { results } = await env.DB.prepare(
        'SELECT * FROM news WHERE date = ? ORDER BY rank'
      )
        .bind(date)
        .all();

      return new Response(renderHTML(results, date), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // / - 루트: /hn 으로 리다이렉트
    if (path === '/') {
      return Response.redirect(new URL('/hn', request.url).toString(), 302);
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron 트리거 (매일 UTC 00:00 = KST 09:00)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(crawlAndStore(env));
  },
};
