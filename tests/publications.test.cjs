const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'public/hn/index.html'), 'utf8').replace(/\r\n/g, '\n');
const sitemap = fs.readFileSync(path.join(root, 'public/sitemap.xml'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations/0001_publications.sql'), 'utf8');
const publications = import('../src/publications.mjs');
const seo = import('../src/seo.mjs');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const DB = { prepare(sql) {
    const stmt = sqlite.prepare(sql);
    const bind = (...values) => ({
      async run() { return stmt.run(...values); },
      async all() { return { results: stmt.all(...values) }; },
      async first() { return stmt.get(...values) || null; },
    });
    return { bind, ...bind() };
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const rows = []; for (const statement of statements) rows.push(await statement.run()); sqlite.exec('COMMIT'); return rows; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB };
}
const article = overrides => ({ source_key: 'agency', source_item_id: 'external-123', source_name: 'Agency', category: 'science', original_title: 'Original', title: 'Translated title', summary: 'Summary', body: 'First paragraph.\n\nLast paragraph.', original_url: 'https://example.com/article', translation_status: 'full', ...overrides });
function addDaily(sqlite, overrides = {}) {
  const row = { hn_id: 123, date: '2026-10-10', rank: 1, original_title: 'Original', translated_title: 'Translated title', summary: 'Summary', explanation: 'Complete body.', url: 'https://example.com/article', created_at: '2026-10-09 14:00:00', translation_status: 'full', ...overrides };
  sqlite.prepare(`INSERT INTO news (${Object.keys(row)}) VALUES (${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
}

test('publication IDs and first publication dates survive retries, changes, and source ID collisions', async () => {
  const { DB, sqlite } = database();
  const { publishArticles } = await publications;
  await publishArticles({ DB }, [article()], '2026-10-10T14:00:00Z');
  const before = sqlite.prepare('SELECT * FROM articles').get();
  await publishArticles({ DB }, [article()], '2026-10-11T14:00:00Z');
  assert.deepEqual(sqlite.prepare('SELECT * FROM articles').get(), before);
  await publishArticles({ DB }, [article({ body: 'Updated body.' })], '2026-10-12T14:00:00Z');
  const after = sqlite.prepare('SELECT * FROM articles').get();
  assert.equal(after.id, before.id);
  assert.equal(after.published_at, before.published_at);
  assert.equal(after.modified_at, '2026-10-12T14:00:00.000Z');
  await publishArticles({ DB }, [article({ source_key: 'other-agency', category: 'economy' })]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 2);
  for (const bad of [{ translation_status: 'failed' }, { category: 'unknown' }, { original_url: 'javascript:alert(1)' }]) {
    await assert.rejects(publishArticles({ DB }, [article(bad)]));
  }
});

test('migration is repeatable, keeps daily rows, excludes failed/legacy entries and picks the latest complete translation', async () => {
  const { sqlite } = database();
  addDaily(sqlite);
  addDaily(sqlite, { date: '2026-10-11', created_at: '2026-10-10 14:00:00', explanation: 'Updated body.' });
  addDaily(sqlite, { hn_id: 124, rank: 2, translation_status: 'failed' });
  addDaily(sqlite, { hn_id: 125, rank: 3, translation_status: 'legacy' });
  sqlite.exec(migration);
  const before = sqlite.prepare('SELECT * FROM articles').all();
  sqlite.exec(migration);
  assert.deepEqual(sqlite.prepare('SELECT * FROM articles').all(), before);
  assert.equal(before.length, 1);
  assert.equal(before[0].body, 'Updated body.');
  assert.equal(before[0].published_at, '2026-10-09T14:00:00Z');
  assert.equal(before[0].modified_at, '2026-10-10T14:00:00Z');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM news').get().n, 4);
});

test('daily replacement and failed retranslations cannot delete or overwrite a published article', async () => {
  const { DB, sqlite } = database();
  const { storeNews } = await import('../src/pipeline.mjs');
  const story = { id: 123, title: 'Original', url: 'https://example.com/article' };
  const translated = { translated: 'Title', summary: 'Summary', explanation: 'Complete body', original_content: 'Source', translation_status: 'full', models: '', format: '' };
  await storeNews({ DB }, '2026-10-10', [story], [translated]);
  const before = sqlite.prepare('SELECT * FROM articles').get();
  await storeNews({ DB }, '2026-10-10', [story], [translated]);
  assert.equal(sqlite.prepare('SELECT * FROM articles').get().id, before.id);
  await storeNews({ DB }, '2026-10-10', [story], [{ ...translated, translation_status: 'failed', explanation: 'Failed' }], true);
  assert.equal(sqlite.prepare('SELECT * FROM articles').get().body, before.body);
  assert.equal(sqlite.prepare('SELECT * FROM news').get().explanation, before.body);
});

test('HTML responses contain article text, unique metadata, safe JSON and discoverable links without JS', async () => {
  const { DB, sqlite } = database();
  const { servePublication } = await seo;
  addDaily(sqlite, { translated_title: '</script><script>alert(1)</script> $&', explanation: 'Last paragraph of article.' });
  sqlite.exec(migration);
  const request = p => servePublication(new Request('https://news.archerlab.dev' + p), { DB }, template, sitemap);
  const list = await (await request('/hn/?date=2026-10-10')).text();
  assert.match(list, /rel="canonical" href="https:\/\/news.archerlab.dev\/hn\/\?date=2026-10-10"/);
  assert.match(list, /<a class="news-title" href="\/article\/1">/);
  assert.match(list, /id="news-data"/);
  assert.doesNotMatch(list, /<script>alert\(1\)<\/script>/);
  const detail = await (await request('/article/1')).text();
  assert.match(detail, /Last paragraph of article/);
  assert.match(detail, /"@type":"Article"/);
  assert.match(detail, /rel="canonical" href="https:\/\/news.archerlab.dev\/article\/1"/);
  assert.match(detail, /&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; \$&amp;/);
  assert.doesNotMatch(detail, /<script>alert\(1\)<\/script>/);
  const head = await servePublication(new Request('https://news.archerlab.dev/article/1', { method: 'HEAD' }), { DB }, template, sitemap);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/article/999', '/article/0', '/hn/?date=2026-02-29', '/hn/?date=2025-01-01', '/articles/?page=0', '/articles/?category=bogus']) {
    const r = await request(path); assert.equal(r.status, 404, path); assert.match(r.headers.get('x-robots-tag'), /noindex/);
  }
  assert.equal((await request('/article/1/')).headers.get('location'), 'https://news.archerlab.dev/article/1');
});

test('sitemaps discover all publications and archive dates; catalogs work across categories', async () => {
  const { DB, sqlite } = database();
  const { publishArticles } = await publications;
  const { servePublication } = await seo;
  addDaily(sqlite);
  sqlite.exec(migration);
  await publishArticles({ DB }, [article(), article({ source_item_id: 'second', category: 'economy' })]);
  const request = async p => (await servePublication(new Request('https://news.archerlab.dev' + p), { DB }, template, sitemap)).text();
  assert.match(await request('/sitemap.xml'), /sitemaps\/articles-1.xml/);
  assert.match(await request('/sitemaps/articles-1.xml'), /<loc>https:\/\/news.archerlab.dev\/article\/3<\/loc>/);
  assert.match(await request('/sitemaps/dates-1.xml'), /hn\/\?date=2026-10-10/);
  const pages = await request('/sitemaps/pages.xml');
  assert.match(pages, /articles\/\?category=economy/);
  const filtered = await request('/articles/?category=economy');
  assert.match(filtered, /href="\/article\/3"/);
  assert.doesNotMatch(filtered, /href="\/article\/2"/);
  assert.match(filtered, /canonical" href="https:\/\/news.archerlab.dev\/articles\/\?category=economy/);
});

test('large catalogs split sitemaps without dropping older URLs and reject pages beyond the end', async () => {
  const { DB } = database();
  const { publishArticles } = await publications;
  const { servePublication } = await seo;
  await publishArticles({ DB }, Array.from({ length: 1001 }, (_, i) => article({ source_item_id: String(i) })), '2026-10-10T00:00:00Z');
  const request = path => servePublication(new Request('https://news.archerlab.dev' + path), { DB }, template, sitemap);
  assert.match(await (await request('/sitemap.xml')).text(), /articles-2.xml/);
  const first = await (await request('/sitemaps/articles-1.xml')).text();
  const second = await (await request('/sitemaps/articles-2.xml')).text();
  assert.equal((first.match(/<url>/g) || []).length, 1000);
  assert.equal((second.match(/<url>/g) || []).length, 1);
  assert.match(second, /\/article\/1001</);
  assert.equal((await request('/sitemaps/articles-3.xml')).status, 404);
  assert.match(await (await request('/articles/?page=2')).text(), /canonical" href="https:\/\/news.archerlab.dev\/articles\/\?page=2"/);
  assert.equal((await request('/articles/?page=35')).status, 404);
});
