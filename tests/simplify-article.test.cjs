const assert = require('node:assert/strict');
const test = require('node:test');

const simplifyModule = import('../src/simplify.mjs');
const pipelineModule = import('../src/pipeline.mjs');

function plain(overrides = {}) {
  return {
    translated: '쉬운 한국어 제목',
    summary: '비전문가도 읽는 미리보기',
    what: '이 기사가 다루는 일을 처음부터 쉬운 말로 설명합니다. ',
    why: '무엇이 달라졌는지와 그 차이가 왜 중요한지 설명합니다. ',
    core: '원문의 중요한 사실과 조건을 일상적인 말로 이어서 설명합니다. '.repeat(4),
    impact: '일반 독자에게 당장 무엇이 달라질 수 있는지와 아직 모르는 점을 밝힙니다. ',
    ...overrides,
  };
}

test('plain rewrite keeps four sections, an easy title, and the source-checked wording', async () => {
  const { simplifyForNonItReaders } = await simplifyModule;
  const source = '25% of the provider customer prefixes were withdrawn.';
  const translation = {
    translated: '기술 제목',
    summary: '기술 미리보기',
    explanation: '기존 설명입니다. '.repeat(20),
    format: 'explained_full_v1',
    models: 'primary',
  };
  const result = await simplifyForNonItReaders(translation, source, async prompt => {
    assert.ok(prompt.startsWith('[NEWS_NONIT_REWRITE]'));
    assert.ok(prompt.includes(JSON.stringify(source)));
    assert.ok(prompt.includes(JSON.stringify(translation.explanation)));
    return { model: 'plain-model', text: JSON.stringify(plain({ core: '해당 서비스의 고객 주소 대역 중 25%만 해당합니다. '.repeat(3) })) };
  });
  assert.equal(result.translated, '쉬운 한국어 제목');
  assert.equal(result.summary, '비전문가도 읽는 미리보기');
  assert.equal(result.format, 'explained_plain_v1');
  assert.match(result.explanation, /해당 서비스의 고객 주소 대역 중 25%/);
  assert.match(result.explanation, /1\. 이게 뭔가요\?/);
  assert.match(result.explanation, /4\. 나에게 어떤 영향이 있나요\?/);
  assert.match(result.models, /plain-model/);
});

test('a failed rewrite keeps the previous translation instead of dropping the article', async () => {
  const { simplifyForNonItReaders } = await simplifyModule;
  const translation = { translated: '제목', summary: '미리보기', explanation: '기존 본문', format: 'explained_full_v1', models: 'primary' };
  let calls = 0;
  const result = await simplifyForNonItReaders(translation, 'Original article.', async () => {
    calls++;
    return { text: '{"what":"too short"}' };
  });
  assert.equal(calls, 2);
  assert.equal(result, translation);
});

test('prepareNews rewrites a saved article after translation', async () => {
  const { prepareNews } = await pipelineModule;
  const saved = 'The complete archived article, including its final sentence.';
  const rows = await prepareNews([{ id: 1, title: 'Saved article', original_content: saved }], async prompt => {
    if (prompt.startsWith('[NEWS_NONIT_REWRITE]')) {
      return { text: JSON.stringify(plain({ translated: '보관된 기사', summary: '쉬운 보관 기사' })) };
    }
    if (prompt.startsWith('[NEWS_GUIDE_')) return { text: '{"what":"기초 설명입니다. 개념을 잇습니다.","why":"주목할 이유입니다. 한계도 있습니다.","impact":"생활 속 영향입니다. 불확실합니다."}' };
    const segments = JSON.parse(prompt.split('Source segments:\n')[1]);
    return { text: JSON.stringify({ translated: '저장된 기사', summary: '카드 미리보기', segments: segments.map(s => ({ id: s.id, text: s.text })) }) };
  }, async () => { throw Error('The saved source must not require a fetch'); });
  assert.equal(rows[0].translated, '보관된 기사');
  assert.equal(rows[0].format, 'explained_plain_v1');
  assert.equal(rows[0].translation_status, 'full');
  assert.match(rows[0].explanation, /1\. 이게 뭔가요\?/);
});
