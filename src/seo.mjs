import { CATEGORIES, readEdition } from './publications.mjs';

const ORIGIN = 'https://news.archerlab.dev';
const SITEMAP_SIZE = 1000;
const PAGE_SIZE = 30;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const dateLabel = date => new Date(`${date}T00:00:00+09:00`).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const editionPath = date => `/hn/?date=${date}`;
const articlePath = id => `/article/${id}`;
const response = (body, status = 200, type = 'text/html; charset=utf-8') => new Response(body, {
  status, headers: { 'Content-Type': type, 'Cache-Control': status === 200 ? 'public, max-age=0, s-maxage=300' : 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(status !== 200 ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) },
});
const missing = () => response('Not Found', 404, 'text/plain; charset=utf-8');
const redirect = path => new Response(null, { status: 301, headers: { Location: ORIGIN + path } });
const collectionSchema = (url, title, rows) => ({
  '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': url, url, name: title, inLanguage: 'ko-KR',
  mainEntity: { '@type': 'ItemList', itemListElement: rows.filter(row => row.article_id || row.id).map((row, index) => ({
    '@type': 'ListItem', position: index + 1, url: ORIGIN + articlePath(row.article_id || row.id), name: row.translated_title || row.title,
  })) },
});

export function metadata(template, { title, description, path, schema, type = 'website' }) {
  const url = ORIGIN + path;
  const attribute = value => (_match, before, after) => before + escape(value) + after;
  return template.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escape(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*("\s*\/?>)/, attribute(description))
    .replace(/(<meta (?:property|name)="(?:og:title|twitter:title)" content=")[^"]*("\s*\/?>)/g, attribute(title))
    .replace(/(<meta (?:property|name)="(?:og:description|twitter:description)" content=")[^"]*("\s*\/?>)/g, attribute(description))
    .replace(/(<meta property="og:url" content=")[^"]*("\s*\/?>)/, attribute(url))
    .replace(/(<meta property="og:type" content=")[^"]*("\s*\/?>)/, attribute(type))
    .replace(/(<link rel="canonical" href=")[^"]*("\s*\/?>)/, attribute(url))
    .replace(/(<link rel="alternate" hreflang="[^"]+" href=")[^"]*("\s*\/?>)/g, attribute(url))
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">${json(schema)}</script>`);
}

export function renderCards(rows) {
  return rows.map((item, i) => `<article class="news-card" style="--i:${i}" data-news-index="${i}" role="button" tabindex="0" aria-label="${escape(item.translated_title)} 상세 보기">
          <div class="news-rank">${Number(item.rank) || i + 1}</div>
          <div class="news-body">
            ${item.article_id ? `<a class="news-title" href="${articlePath(item.article_id)}">${escape(item.translated_title)}</a>` : `<span class="news-title">${escape(item.translated_title)}</span>`}
            <p class="news-summary">${escape(item.summary || '')}</p>
            <div class="news-meta">
              <span class="news-original" title="${escape(item.original_title)}">${escape(item.original_title)}</span>
              <span class="news-score">▲ ${Number(item.score) || 0}</span>
            </div>
          </div>
        </article>`).join('');
}

export function renderEdition(template, edition, requestedDate) {
  const path = requestedDate ? editionPath(edition.date) : '/hn/';
  const title = `${edition.date} Hacker News 한국어 뉴스 | HN 탑10`;
  const schema = collectionSchema(ORIGIN + path, title, edition.news.filter(row => row.article_id));
  let html = metadata(template, { title, path, description: edition.news.slice(0, 3).map(row => row.translated_title).join(' · ').slice(0, 200), schema });
  html = html.replace(/(<span id="badge-text">)[\s\S]*?(<\/span>)/, `$1${edition.date === today() ? '오늘 업데이트' : '아카이브'}$2`)
    .replace('<p class="hero-date" id="hero-date"></p>', `<p class="hero-date" id="hero-date">${dateLabel(edition.date)}</p>`)
    .replace(/(<section class="news-list" id="news-list"[^>]*>)[\s\S]*?(<\/section>)/, () => `<section class="news-list" id="news-list" aria-label="뉴스 목록">${renderCards(edition.news)}</section>`)
    .replace(/<noscript>[\s\S]*?<\/noscript>/, '')
    .replace('<script>\n  const API', `<script id="news-data" type="application/json">${json(edition)}</script>\n<script>\n  const API`);
  for (const [id, date] of [['prev', edition.prevDate], ['next', edition.nextDate]]) {
    if (date) html = html.replace(`id="btn-${id}" role="button" aria-disabled="true"`, `id="btn-${id}" role="button" aria-disabled="false" href="${editionPath(date)}"`);
  }
  return html;
}

export function renderArticleBody(body) {
  return escape(body).split(/\n\n+/).map(part => /^\d+\. [^\n]+\n/.test(part)
    ? part.replace(/^(\d+\. [^\n]+)\n([\s\S]*)$/, '<section><h2 class="modal-section-label">$1</h2><p class="article-text">$2</p></section>')
    : `<p class="article-text">${part}</p>`).join('\n');
}

function documentShell(template, options, content) {
  const head = metadata(template, options).match(/<head>([\s\S]*?)<\/head>/)[1]
    .replaceAll('href="../assets/', 'href="/assets/').replaceAll('src="../assets/', 'src="/assets/')
    .replace(/<meta property="og:site_name"[^>]*>/, '<meta property="og:site_name" content="ArcherLab 뉴스">');
  return `<!DOCTYPE html><html lang="ko"><head>${head}
    <style>.article-page{max-width:760px;width:100%;margin:0 auto;padding:2rem 1.5rem 3rem}.article-page h1{font-size:clamp(1.5rem,4vw,2rem);line-height:1.5;margin:1rem 0}.article-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.9;margin:1rem 0}.article-page a{color:var(--link)}.article-meta{color:var(--text-muted);font-size:.85rem;line-height:1.8}.article-page nav{display:flex;gap:1rem;margin:1.5rem 0}.article-list{list-style:none}.article-list li{padding:1rem 0;border-bottom:1px solid var(--border)}.article-list h2{font-size:1.1rem;line-height:1.6}.article-list p{margin-top:.5rem;color:var(--text-muted);line-height:1.7}</style>
    </head><body><main class="article-page">${content}</main></body></html>`;
}

export function renderArticle(template, article) {
  const path = articlePath(article.id), url = ORIGIN + path;
  const schema = {
    '@context': 'https://schema.org', '@type': 'Article', '@id': url + '#article', url,
    mainEntityOfPage: url, headline: article.title, description: article.summary, inLanguage: 'ko-KR',
    datePublished: article.published_at, dateModified: article.modified_at,
    articleSection: CATEGORIES[article.category], isAccessibleForFree: true,
    author: { '@type': 'Organization', name: 'ArcherLab', url: ORIGIN + '/seo/hn-top10-about' },
    publisher: { '@type': 'Organization', name: 'ArcherLab', url: 'https://archerlab.dev/' },
    isBasedOn: { '@type': 'CreativeWork', name: article.original_title, url: article.original_url },
  };
  const formatted = timestamp => new Date(timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' });
  return documentShell(template, { title: `${article.title} | ArcherLab 뉴스`, path, description: article.summary, schema, type: 'article' }, `
    <nav><a href="/">ArcherLab 뉴스</a><a href="/articles/">기사 목록</a><a href="/articles/?category=${article.category}">${escape(CATEGORIES[article.category])}</a></nav>
    <article><h1>${escape(article.title)}</h1>
      <p class="article-meta">ArcherLab · AI 번역·요약 · 출처: ${escape(article.source_name)}<br>
      게시 <time datetime="${escape(article.published_at)}">${formatted(article.published_at)}</time> (KST)
      ${article.modified_at !== article.published_at ? `<br>수정 <time datetime="${escape(article.modified_at)}">${formatted(article.modified_at)}</time> (KST)` : ''}</p>
      <div>${renderArticleBody(article.body)}</div>
      <nav><a href="${escape(article.original_url)}" rel="noopener noreferrer" target="_blank">원문 보기 →</a>
      ${article.source_key === 'hacker-news' && /^\d+$/.test(article.source_item_id) ? `<a href="https://news.ycombinator.com/item?id=${article.source_item_id}" rel="noopener noreferrer" target="_blank">HN 토론 →</a>` : ''}</nav>
      <p class="article-meta">AI가 번역·요약한 글입니다. 정확한 표현과 세부 내용은 원문에서 확인해 주세요.</p>
    </article>`);
}

async function renderCatalog(request, env, template) {
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const pageParam = url.searchParams.get('page') || '1';
  if ((category !== null && !Object.hasOwn(CATEGORIES, category)) || !/^[1-9]\d{0,5}$/.test(pageParam)) return missing();
  const page = Number(pageParam);
  const where = category ? 'WHERE category = ?' : '';
  const bindings = category ? [category] : [];
  const { total } = await env.DB.prepare(`SELECT COUNT(*) AS total FROM articles ${where}`).bind(...bindings).first();
  if (!total || (page - 1) * PAGE_SIZE >= total) return missing();
  const { results } = await env.DB.prepare(`SELECT id, title, summary, published_at FROM articles ${where} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...bindings, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();
  const pathFor = number => '/articles/' + (category || number > 1 ? '?' + new URLSearchParams({ ...(category ? { category } : {}), ...(number > 1 ? { page: String(number) } : {}) }) : '');
  const title = `${category ? CATEGORIES[category] + ' ' : ''}기사 목록`;
  return response(documentShell(template, {
    title: `${title} · ${page} | ArcherLab 뉴스`, description: results.slice(0, 3).map(row => row.title).join(' · ').slice(0, 200),
    path: pathFor(page), schema: collectionSchema(ORIGIN + pathFor(page), title, results),
  }, `<nav><a href="/">ArcherLab 뉴스</a><a href="/hn/">HN 탑10</a></nav><h1>${escape(title)}</h1>
    <ul class="article-list">${results.map(row => `<li><h2><a href="${articlePath(row.id)}">${escape(row.title)}</a></h2><p>${escape(row.summary)}</p></li>`).join('')}</ul>
    <nav>${page > 1 ? `<a href="${escape(pathFor(page - 1))}">← 이전</a>` : ''}${page * PAGE_SIZE < total ? `<a href="${escape(pathFor(page + 1))}">다음 →</a>` : ''}</nav>`));
}

async function sitemap(path, env, staticSitemap) {
  const xml = body => response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, 200, 'application/xml; charset=utf-8');
  const entry = (path, modified) => `<url><loc>${escape(ORIGIN + path)}</loc>${modified ? `<lastmod>${escape(modified)}</lastmod>` : ''}</url>`;
  const set = entries => xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
  if (path === '/sitemap.xml') {
    const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM articles) AS articles, (SELECT COUNT(DISTINCT date) FROM news) AS dates').first();
    const paths = ['/sitemaps/pages.xml'];
    for (const kind of ['articles', 'dates']) for (let i = 1; i <= Math.ceil(counts[kind] / SITEMAP_SIZE); i++) paths.push(`/sitemaps/${kind}-${i}.xml`);
    return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<sitemap><loc>${ORIGIN + p}</loc></sitemap>`).join('')}</sitemapindex>`);
  }
  if (path === '/sitemaps/pages.xml') {
    const latest = await env.DB.prepare('SELECT MAX(modified_at) AS modified FROM articles').first();
    const entries = [...staticSitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([whole, inner]) => {
      const loc = inner.match(/<loc>([^<]+)<\/loc>/)?.[1];
      if (loc === ORIGIN + '/hn/') return entry('/hn/', latest?.modified);
      return whole;
    }).join('');
    const { results: categories } = await env.DB.prepare('SELECT category, MAX(modified_at) AS modified FROM articles GROUP BY category').all();
    return set(entries + (latest?.modified ? entry('/articles/', latest.modified) : '') + categories.map(row => entry(`/articles/?category=${row.category}`, row.modified)).join(''));
  }
  const match = path.match(/^\/sitemaps\/(articles|dates)-([1-9]\d{0,5})\.xml$/);
  if (!match) return missing();
  const offset = (Number(match[2]) - 1) * SITEMAP_SIZE;
  const { results } = match[1] === 'articles'
    ? await env.DB.prepare('SELECT id, modified_at FROM articles ORDER BY id LIMIT ? OFFSET ?').bind(SITEMAP_SIZE, offset).all()
    : await env.DB.prepare('SELECT date, MAX(created_at) AS modified_at FROM news GROUP BY date ORDER BY date LIMIT ? OFFSET ?').bind(SITEMAP_SIZE, offset).all();
  if (!results.length) return missing();
  return set(results.map(row => entry(match[1] === 'articles' ? articlePath(row.id) : editionPath(row.date), row.modified_at && new Date(row.modified_at.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(row.modified_at) ? '' : 'Z')).toISOString())).join(''));
}

export async function servePublication(request, env, template, staticSitemap) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'X-Robots-Tag': 'noindex, nofollow' } });
  const url = new URL(request.url), path = url.pathname;
  let result;
  if (path === '/hn' || path === '/hn/index.html') result = redirect('/hn/' + url.search);
  else if (path === '/articles' || path === '/articles/index.html') result = redirect('/articles/' + url.search);
  else if (path === '/hn/') {
    const date = url.searchParams.get('date');
    if (date !== null && !validDate(date)) return missing();
    const edition = await readEdition(env.DB, date || today(), { exact: date !== null });
    result = edition ? response(renderEdition(template, edition, date)) : missing();
  } else if (path === '/articles/') result = await renderCatalog(request, env, template);
  else if (path === '/sitemap.xml' || path.startsWith('/sitemaps/')) result = await sitemap(path, env, staticSitemap);
  else {
    const match = path.match(/^\/article\/([1-9]\d{0,14})(\/|\/index\.html)?$/);
    if (!match) return missing();
    if (match[2]) return redirect(articlePath(match[1]) + url.search);
    const article = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(Number(match[1])).first();
    result = article ? response(renderArticle(template, article)) : missing();
  }
  return request.method === 'HEAD' ? new Response(null, { status: result.status, headers: result.headers }) : result;
}
