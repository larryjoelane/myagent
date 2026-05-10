// Tests for memory_search and memory_store. Use fake search/store
// closures injected via ctx.memory — the tools should never touch a
// real index.

const memorySearch = require('../src/core/llm/tools/memorySearch');
const memoryStore = require('../src/core/llm/tools/memoryStore');
const { eq, ok, contains, deepEq } = require('./assert');

function run(ctx) {
  // ----- memory_search -------------------------------------------------------

  ctx.test('memory_search: refuses without backend', async () => {
    const r = await memorySearch.run({ query: 'x' }, {});
    eq(r.ok, false);
    contains(r.content, 'no memory backend');
  });

  ctx.test('memory_search: empty query is rejected', async () => {
    const r = await memorySearch.run({ query: '   ' }, { memory: { search: async () => [] } });
    eq(r.ok, false);
    contains(r.content, 'query');
  });

  ctx.test('memory_search: returns formatted hits', async () => {
    let seenOpts;
    const fakeHits = [
      { ts: '2026-01-01T00:00:00Z', confidence: 0.91, text: 'first hit body' },
      { ts: '2026-01-02T00:00:00Z', confidence: 0.72, snippet: 'second hit snippet' },
    ];
    const memory = { search: async (opts) => { seenOpts = opts; return fakeHits; } };
    const r = await memorySearch.run({ query: 'auth flow', limit: 5 }, { memory });
    eq(r.ok, true);
    eq(seenOpts.query, 'auth flow');
    eq(seenOpts.limit, 5);
    contains(r.content, 'first hit body');
    contains(r.content, 'second hit snippet');
    contains(r.content, 'conf 0.91');
  });

  ctx.test('memory_search: cap truncates body and notes the cut', async () => {
    const big = 'x'.repeat(5000);
    const memory = { search: async () => [{ ts: '2026-01-01T00:00:00Z', text: big }] };
    const r = await memorySearch.run({ query: 'q', cap: 100 }, { memory });
    eq(r.ok, true);
    contains(r.content, 'more chars');
  });

  ctx.test('memory_search: full=true skips truncation', async () => {
    const big = 'x'.repeat(5000);
    const memory = { search: async () => [{ ts: '2026-01-01T00:00:00Z', text: big }] };
    const r = await memorySearch.run({ query: 'q', full: true }, { memory });
    eq(r.ok, true);
    ok(!r.content.includes('more chars'));
    ok(r.content.includes('xxxx'));
  });

  ctx.test('memory_search: search throw becomes ok:false', async () => {
    const memory = { search: async () => { throw new Error('db down'); } };
    const r = await memorySearch.run({ query: 'q' }, { memory });
    eq(r.ok, false);
    contains(r.content, 'db down');
  });

  // ----- memory_store --------------------------------------------------------

  ctx.test('memory_store: refuses without backend', async () => {
    const r = await memoryStore.run({ text: 'remember me' }, {});
    eq(r.ok, false);
    contains(r.content, 'no memory backend');
  });

  ctx.test('memory_store: empty text rejected', async () => {
    const r = await memoryStore.run({ text: '   ' }, { memory: { store: async () => ({}) } });
    eq(r.ok, false);
    contains(r.content, 'text');
  });

  ctx.test('memory_store: forwards to backend with defaults', async () => {
    let saved;
    const memory = { store: async (body) => { saved = body; return { id: 42 }; } };
    const r = await memoryStore.run({ text: 'hello world' }, { memory });
    eq(r.ok, true);
    eq(saved.text, 'hello world');
    eq(saved.source, 'llm');
    deepEq(saved.tags, ['llm', 'note']);
    contains(r.content, 'Saved (#42)');
  });

  ctx.test('memory_store: custom tags and source honored', async () => {
    let saved;
    const memory = { store: async (body) => { saved = body; return { id: 1 }; } };
    await memoryStore.run({ text: 't', tags: ['a', 'b'], source: 'custom' }, { memory });
    deepEq(saved.tags, ['a', 'b']);
    eq(saved.source, 'custom');
  });

  ctx.test('memory_store: backend throw becomes ok:false', async () => {
    const memory = { store: async () => { throw new Error('disk full'); } };
    const r = await memoryStore.run({ text: 't' }, { memory });
    eq(r.ok, false);
    contains(r.content, 'disk full');
  });
}

module.exports = { run };
