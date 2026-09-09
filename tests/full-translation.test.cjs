const assert = require('node:assert/strict');
const test = require('node:test');

const articleModule = import('../src/articles.mjs');
const pipelineModule = import('../src/pipeline.mjs');

test('extraction retains the complete article, paragraphs, entities and code after the old limits', async () => {
  const { extractArticleText } = await articleModule;
  const paragraphs = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}. ${'All original details matter. '.repeat(12)}</p>`).join('');
  const text = extractArticleText(`<html><body><nav>IGNORE_NAV</nav><article><h1>Full article</h1>${paragraphs}<pre>if (x &lt; 5) {\n  run();\n}</pre><p>FINAL_SENTENCE &#169; &amp; complete.</p></article><footer>IGNORE_FOOTER</footer></body></html>`);
  assert.ok(text.length > 20000);
  for (let i = 0; i < 60; i++) assert.ok(text.includes(`Paragraph ${i}.`));
  assert.match(text, /if \(x < 5\) \{\n  run\(\);\n\}/);
  assert.match(text, /FINAL_SENTENCE © & complete\.$/);
  assert.doesNotMatch(text, /IGNORE_NAV|IGNORE_FOOTER/);
  assert.ok(text.includes('\n\n'));
});

test('long source splits without losing any non-whitespace characters including final paragraphs', async () => {
  const { splitArticle } = await articleModule;
  const source = `${'Long paragraph with 🦊 and facts. '.repeat(1200)}\n\nLAST PARAGRAPH.`;
  const batches = splitArticle(source);
  const segments = batches.flat();
  assert.ok(batches.length > 4);
  assert.equal(segments.map(s => s.text).join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
  segments.forEach((segment, id) => assert.equal(segment.id, id));
  assert.ok(segments.at(-1).text.includes('LAST PARAGRAPH.'));
});

test('every source segment reaches the model and every translated segment reaches the body', async () => {
  const { translateArticle } = await articleModule;
  const source = Array.from({ length: 35 }, (_, i) => `Source paragraph ${i}: ${'Facts and original quotes. '.repeat(20)}`).join('\n\n');
  const received = [];
  const notes = [];
  let overviewCalls = 0;
  const result = await translateArticle({ title: 'A long article', url: 'https://example.com/article' }, source, async prompt => {
    if (prompt.startsWith('[NEWS_GUIDE_OVERVIEW]')) {
      overviewCalls++;
      const guideNotes = JSON.parse(prompt.split('Source-grounded notes from all article parts:\n')[1]);
      assert.deepEqual(guideNotes.map(part => part.notes), notes.map(note => note.trim()));
      assert.ok(guideNotes.at(-1).notes.includes('Source paragraph 34:'));
      return { model: 'guide-model', text: JSON.stringify({ what: '기초 개념 설명', why: '주목할 이유와 한계', impact: '생활에 미치는 영향' }) };
    }
    const segments = JSON.parse(prompt.split('Source segments:\n')[1]);
    received.push(...segments);
    const guideNotes = segments.map(s => s.text).join('\n');
    notes.push(guideNotes);
    return { model: 'test-model', finishReason: 'stop', text: JSON.stringify({ translated: '제목', summary: '짧은 카드 미리보기', guideNotes, segments: segments.map(s => ({ id: s.id, text: `번역 ${s.id}: ${s.text}` })) }) };
  });
  assert.equal(received.map(s => s.text).join('\n\n'), source);
  received.forEach(s => assert.ok(result.explanation.includes(`번역 ${s.id}:`)));
  assert.ok(result.explanation.includes('Source paragraph 34:'));
  assert.equal(result.models, 'test-model,guide-model');
  assert.equal(result.format, 'explained_full_v1');
  assert.equal(overviewCalls, 1);
  const { EXPLANATION_HEADINGS } = await articleModule;
  const positions = EXPLANATION_HEADINGS.map(heading => result.explanation.indexOf(heading));
  assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])));
  const fullBody = result.explanation.slice(positions[2], positions[3]);
  received.forEach(s => assert.ok(fullBody.includes(`번역 ${s.id}:`)));
});

test('an incomplete or truncated framing guide never replaces a complete article', async () => {
  const { validateGuide, translateArticle } = await articleModule;
  assert.throws(() => validateGuide({ text: '{"what":"Only an introduction"}' }), /section missing/);
  assert.throws(() => validateGuide({ finishReason: 'length', text: '{"what":"a","why":"b","impact":"c"}' }), /truncated/);
  let overviewCalls = 0;
  await assert.rejects(translateArticle({ title: 'Source' }, 'Full source body.', async prompt => {
    if (prompt.startsWith('[NEWS_GUIDE_OVERVIEW]')) {
      overviewCalls++;
      return { text: '{"what":"Incomplete"}' };
    }
    return { text: JSON.stringify({ translated: '제목', guideNotes: 'All facts.', segments: [{ id: 0, text: '원문의 모든 내용을 쉬운 말로 풀어 옮긴 본문입니다.' }] }) };
  }), /section missing/);
  assert.equal(overviewCalls, 2);
});

test('restyling uses the saved complete source even when the original website is unavailable', async () => {
  const { prepareNews } = await pipelineModule;
  const saved = 'The complete archived article, including its final sentence.';
  let received = '';
  const rows = await prepareNews([{ id: 1, title: 'Saved article', original_content: saved }], async prompt => {
    if (prompt.startsWith('[NEWS_GUIDE_OVERVIEW]')) return { text: '{"what":"기초 설명","why":"주목할 이유","impact":"생활 속 영향"}' };
    const segments = JSON.parse(prompt.split('Source segments:\n')[1]);
    received = segments.map(s => s.text).join('');
    return { text: JSON.stringify({ translated: '저장된 기사', guideNotes: 'All archived facts.', segments: segments.map(s => ({ id: s.id, text: s.text })) }) };
  }, async () => { throw Error('The saved source must not require a fetch'); });
  assert.equal(received, saved);
  assert.equal(rows[0].original_content, saved);
  assert.equal(rows[0].translation_status, 'full');
  assert.equal(rows[0].format, 'explained_full_v1');
});

test('missing, reordered, summarized and truncated output cannot become a full translation', async () => {
  const { validateTranslation, translateArticle } = await articleModule;
  const expected = [{ id: 0, text: 'Long source sentence. '.repeat(100) }, { id: 1, text: 'Last paragraph.' }];
  for (const segments of [[], [{ id: 1, text: 'x' }, { id: 0, text: 'x' }], [{ id: 0, text: 'Summary.' }, { id: 1, text: 'Last.' }]]) {
    assert.throws(() => validateTranslation({ text: JSON.stringify({ segments }) }, expected));
  }
  assert.throws(() => validateTranslation({ finishReason: 'length' }, expected), /truncated/);
  let calls = 0;
  await assert.rejects(translateArticle({ title: 'Article' }, 'Original body.', async () => {
    calls++;
    return { text: '{"segments":[]}' };
  }), /missing/);
  assert.equal(calls, 2);
});

test('blocked sources never call the AI with only a title', async () => {
  const { prepareNews } = await pipelineModule;
  let calls = 0;
  const rows = await prepareNews([{ id: 1, title: 'Title alone', url: 'https://example.com' }], async () => { calls++; }, async () => new Response('Forbidden', { status: 403 }));
  assert.equal(calls, 0);
  assert.equal(rows[0].translation_status, 'unavailable');
  assert.equal(rows[0].original_content, '');
  assert.match(rows[0].explanation, /원문 본문을 불러오지 못했습니다/);
});

test('self posts provide their complete body without fetching a comment page', async () => {
  const { fetchArticleContent } = await articleModule;
  const result = await fetchArticleContent({ text: '<p>First</p><p>Last</p>' }, async () => { throw Error('Unexpected fetch'); });
  assert.equal(result, 'First\n\nLast');
});

test('news replacement is one transaction and refresh never deletes the existing lineup', async () => {
  const { storeNews } = await pipelineModule;
  const batches = [], runs = [];
  const env = { DB: {
    prepare(sql) { return { sql, bind(...values) { return { sql, values }; }, async run() { runs.push(sql); } }; },
    async batch(statements) { batches.push(statements); },
  } };
  const story = { id: 7, title: 'Original', url: 'https://example.com', score: 10 };
  const translation = { translated: '제목', summary: '요약', explanation: '전체 번역', original_content: 'Original body', translation_status: 'full', models: 'model', format: 'explained_full_v1' };
  await storeNews(env, '2026-09-09', [story], [translation]);
  assert.equal(batches.length, 1);
  assert.match(batches[0][0].sql, /DELETE FROM news/);
  assert.match(batches[0][1].sql, /INSERT INTO news/);
  assert.equal(batches[0][1].values.at(-1), 'explained_full_v1');
  assert.ok(runs.every(sql => sql.startsWith('ALTER TABLE')));
  await storeNews(env, '2026-09-09', [story], [translation], true);
  assert.equal(batches[1].length, 1);
  assert.match(batches[1][0].sql, /UPDATE news/);
  assert.match(batches[1][0].sql, /COALESCE\(translation_status/);
  assert.equal(batches[1][0].values[6], 'explained_full_v1');
});
