const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');

function loadWorker(fetchImpl = global.fetch) {
  const transformed = source.replace('export default {', 'const worker = {')
    + '\nmodule.exports = { worker, isValidISODate, fetchJson, fetchTopStories, fetchStory };';
  const context = {
    module: { exports: {} },
    exports: {},
    fetch: fetchImpl,
    Request,
    Response,
    URL,
    AbortSignal,
    Date,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(transformed, context, { filename: 'src/index.js' });
  return context.module.exports;
}

test('calendar dates are validated strictly', () => {
  const { isValidISODate } = loadWorker();
  assert.equal(isValidISODate('2026-08-07'), true);
  assert.equal(isValidISODate('2026-02-29'), false);
  assert.equal(isValidISODate('2026-13-01'), false);
  assert.equal(isValidISODate('2026-8-7'), false);
});

test('API and trigger reject invalid methods or dates before side effects', async () => {
  const { worker } = loadWorker();
  const context = { waitUntil() { throw new Error('waitUntil must not run'); } };

  const invalidDate = await worker.fetch(
    new Request('https://news.example/api/news?date=2026-02-29'),
    {},
    context
  );
  assert.equal(invalidDate.status, 400);
  assert.equal(invalidDate.headers.get('x-robots-tag'), 'noindex, nofollow');

  const apiMethod = await worker.fetch(new Request('https://news.example/api/news', { method: 'POST' }), {}, context);
  assert.equal(apiMethod.status, 405);
  assert.equal(apiMethod.headers.get('allow'), 'GET');
  assert.equal(apiMethod.headers.get('x-robots-tag'), 'noindex, nofollow');

  const triggerMethod = await worker.fetch(new Request('https://news.example/trigger'), {}, context);
  assert.equal(triggerMethod.status, 405);
  assert.equal(triggerMethod.headers.get('allow'), 'POST');
  assert.equal(triggerMethod.headers.get('x-robots-tag'), 'noindex, nofollow');

  const notFound = await worker.fetch(new Request('https://news.example/not-found'), {}, context);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('Hacker News fetches fail closed on bad status and schema', async () => {
  const statusWorker = loadWorker(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(statusWorker.fetchTopStories(), /Upstream request failed \(503\)/);

  const schemaWorker = loadWorker(async () => Response.json({ unexpected: true }));
  await assert.rejects(schemaWorker.fetchTopStories(), /invalid story list/);
  assert.equal(await schemaWorker.fetchStory(-1), null);
});

test('deployed UI keeps API data out of inline event attributes', () => {
  const html = fs.readFileSync(path.join(root, 'public/hn/index.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="index, follow,/);
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.doesNotMatch(html, /onclick=["']openModal/);
  assert.doesNotMatch(html, /escapeAttr\s*\(/);
  assert.match(html, /data-news-index="\$\{i\}"/);
  assert.match(html, /closest\(['"]\[data-news-index\]['"]\)/);
  assert.match(html, /url\.protocol === 'https:' \|\| url\.protocol === 'http:'/);
  assert.match(html, /new URLSearchParams\(\{ date: explicitDate \}\)/);
});
