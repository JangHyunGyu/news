const assert = require('node:assert/strict');
const test = require('node:test');
const compactModule = import('../src/compact.mjs');
const pipelineModule = import('../src/pipeline.mjs');

function guide(core = '원문의 중요한 사실과 조건을 쉬운 말로 설명합니다. '.repeat(50)) {
  return { what: '기초 개념을 쉬운 말로 설명합니다. '.repeat(8), why: '어떤 차이가 있는지 근거와 함께 설명합니다. '.repeat(8), core, impact: '생활 속 영향과 아직 확실하지 않은 조건을 설명합니다. '.repeat(8) };
}

test('short articles keep their exact text and make no summarization request', async () => {
  const { compactLongArticle, LONG_ARTICLE_THRESHOLD } = await compactModule;
  const translation = { explanation: 'a'.repeat(LONG_ARTICLE_THRESHOLD), format: 'explained_full_v1' };
  const result = await compactLongArticle(translation, 'Original', async () => { throw Error('Unexpected request'); });
  assert.equal(result, translation);
});

test('long articles retain all four sections and use the source-checked compact version', async () => {
  const { compactLongArticle, COMPACT_ARTICLE_MAX } = await compactModule;
  const source = '25% of the provider customer prefixes were withdrawn. Last original paragraph.';
  const translation = { translated: '제목', summary: '카드 미리보기', explanation: '길게 설명한 본문입니다. '.repeat(800), format: 'explained_full_v1', models: 'primary' };
  let calls = 0;
  const result = await compactLongArticle(translation, source, async prompt => {
    calls++;
    assert.ok(prompt.includes(JSON.stringify(source)));
    return { model: 'review-model', text: JSON.stringify(guide(calls === 2 ? '고객 주소 대역 중 25%라는 범위를 보존합니다. '.repeat(45) : undefined)) };
  });
  assert.equal(calls, 2);
  assert.ok(result.explanation.length <= COMPACT_ARTICLE_MAX);
  assert.ok(result.explanation.length < translation.explanation.length);
  assert.match(result.explanation, /고객 주소 대역 중 25%/);
  assert.equal(result.format, 'explained_summary_v1');
  assert.equal(result.translated, translation.translated);
  assert.equal(result.summary, translation.summary);
  for (const heading of ['1. 이게 뭔가요?', '2. 왜 화제인가요?', '3. 핵심 내용', '4. 나에게 어떤 영향이 있나요?']) assert.ok(result.explanation.includes(heading));
});

test('overlong, incomplete and truncated compact output is rejected', async () => {
  const { validateCompactGuide } = await compactModule;
  assert.throws(() => validateCompactGuide({ text: JSON.stringify(guide('x'.repeat(6000))) }), /length/);
  assert.throws(() => validateCompactGuide({ text: JSON.stringify({ what: 'Only one line' }) }), /missing|too short/);
  assert.throws(() => validateCompactGuide({ finishReason: 'length' }), /truncated/);
});

test('shorten-only mode preserves failed articles and records successful summaries correctly', async () => {
  const { prepareNews, storeNews } = await pipelineModule;
  const previous = { translated: '제목', summary: '미리보기', explanation: '긴 설명입니다. '.repeat(1000), translation_status: 'full', format: 'explained_full_v1', models: 'primary' };
  const failed = { ...previous, explanation: '번역 실패', translation_status: 'failed' };
  let calls = 0;
  const result = await prepareNews([
    { id: 1, original_content: 'Saved original', previous_translation: previous },
    { id: 2, original_content: 'Saved original', previous_translation: failed },
  ], async () => { calls++; return { text: JSON.stringify(guide()) }; }, async () => { throw Error('Unexpected fetch'); }, { shortenOnly: true });
  assert.equal(calls, 2);
  assert.equal(result[0].translation_status, 'summary');
  assert.equal(result[0].original_content, 'Saved original');
  assert.equal(result[1], failed);
  let statement;
  await storeNews({ DB: { prepare(sql) { return { async run() {}, bind(...values) { return { sql, values }; } }; }, async batch(rows) { statement = rows[0]; } } }, '2026-09-08', [{ id: 1 }], [result[0]], true);
  assert.match(statement.sql, /NOT IN \('full', 'summary'\)/);
  assert.equal(statement.values.at(-1), 'summary');
});
