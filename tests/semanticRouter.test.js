// EmbeddingRouter tests. Uses a fake embedder so we don't pull in
// MiniLM — the router only cares about cosine similarity over
// whatever vectors the embedder hands back.

const { ToolKit } = require('../src/core/semantic/toolkit');
const { EmbeddingRouter, cosine } = require('../src/core/semantic/router');
const { eq, ok } = require('./assert');

// Fake embedder: returns a small fixed vector keyed by exact text
// match. Anything not in the table gets a random-ish vector so we can
// test "no match above threshold" cases.
function fakeEmbedder(table) {
  return {
    embed: async (text) => {
      if (table[text]) return new Float32Array(table[text]);
      // Hash-ish: derive a stable vector from char codes so tests are
      // deterministic without colliding with the table entries.
      const v = new Float32Array(4);
      for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) / 1000;
      return normalize(v);
    },
  };
}

function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  if (n === 0) return v;
  const s = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] *= s;
  return v;
}

function makeTool(id, name, description) {
  return { id, name, description, run: async ({ input }) => ({ ok: true, text: `${id}:${input}` }) };
}

exports.run = (ctx) => {
  ctx.test('cosine of identical normalized vectors is ~1', () => {
    const v = normalize(new Float32Array([1, 2, 3, 4]));
    const c = cosine(v, v);
    ok(c > 0.999 && c <= 1.0001, `expected ~1, got ${c}`);
  });

  ctx.test('cosine of orthogonal vectors is ~0', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    const c = cosine(a, b);
    ok(Math.abs(c) < 0.0001, `expected ~0, got ${c}`);
  });

  ctx.test('pick returns null on empty input', async () => {
    const kit = new ToolKit([makeTool('a', 'A', 'desc a')]);
    const router = new EmbeddingRouter({ embedder: fakeEmbedder({}), toolkit: kit });
    const r = await router.pick('');
    eq(r.toolId, null);
    eq(r.reason, 'empty input');
  });

  ctx.test('pick returns null when toolkit is empty', async () => {
    const router = new EmbeddingRouter({ embedder: fakeEmbedder({}), toolkit: new ToolKit() });
    const r = await router.pick('hello');
    eq(r.toolId, null);
    eq(r.reason, 'no tools registered');
  });

  ctx.test('pick chooses the closest tool by cosine', async () => {
    // Vectors: query and toolA share direction; toolB is orthogonal.
    const table = {
      // tool descriptions are "A. desc-a" and "B. desc-b"
      'A. desc-a': normalize([1, 1, 0, 0]),
      'B. desc-b': normalize([0, 0, 1, 1]),
      'find a thing': normalize([1, 1, 0, 0]),
    };
    const kit = new ToolKit([
      makeTool('toolA', 'A', 'desc-a'),
      makeTool('toolB', 'B', 'desc-b'),
    ]);
    const router = new EmbeddingRouter({ embedder: fakeEmbedder(table), toolkit: kit, threshold: 0.5 });
    const r = await router.pick('find a thing');
    eq(r.toolId, 'toolA');
    ok(r.score > 0.99, `score should be ~1, got ${r.score}`);
    eq(r.candidates.length, 2);
    eq(r.candidates[0].toolId, 'toolA');
    eq(r.candidates[1].toolId, 'toolB');
  });

  ctx.test('pick returns null when top score is below threshold', async () => {
    // Query orthogonal to both tools.
    const table = {
      'A. desc-a': normalize([1, 0, 0, 0]),
      'B. desc-b': normalize([0, 1, 0, 0]),
      'unrelated query': normalize([0, 0, 1, 0]),
    };
    const kit = new ToolKit([
      makeTool('toolA', 'A', 'desc-a'),
      makeTool('toolB', 'B', 'desc-b'),
    ]);
    const router = new EmbeddingRouter({ embedder: fakeEmbedder(table), toolkit: kit, threshold: 0.5 });
    const r = await router.pick('unrelated query');
    eq(r.toolId, null);
    ok(r.candidates.length === 2);
  });

  ctx.test('threshold of 0 always picks the best candidate', async () => {
    const table = {
      'A. desc-a': normalize([1, 0, 0, 0]),
      'B. desc-b': normalize([0, 1, 0, 0]),
      'q': normalize([0.6, 0.1, 0, 0]),
    };
    const kit = new ToolKit([
      makeTool('toolA', 'A', 'desc-a'),
      makeTool('toolB', 'B', 'desc-b'),
    ]);
    const router = new EmbeddingRouter({ embedder: fakeEmbedder(table), toolkit: kit, threshold: 0 });
    const r = await router.pick('q');
    eq(r.toolId, 'toolA');
  });

  ctx.test('tool vectors are cached across picks', async () => {
    let embedCalls = 0;
    const embedder = {
      embed: async (text) => {
        embedCalls++;
        const v = new Float32Array(4);
        for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) / 1000;
        return normalize(v);
      },
    };
    const kit = new ToolKit([
      makeTool('toolA', 'A', 'desc-a'),
      makeTool('toolB', 'B', 'desc-b'),
    ]);
    const router = new EmbeddingRouter({ embedder, toolkit: kit, threshold: 0 });
    await router.pick('first query');
    const afterFirst = embedCalls;   // 2 tools + 1 query = 3
    await router.pick('second query');
    const afterSecond = embedCalls;  // +1 query only
    eq(afterFirst, 3);
    eq(afterSecond, 4, 'tool vectors should not be re-embedded');
  });

  ctx.test('tool vectors re-embed when toolkit changes', async () => {
    let embedCalls = 0;
    const embedder = {
      embed: async (text) => {
        embedCalls++;
        const v = new Float32Array(4);
        for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) / 1000;
        return normalize(v);
      },
    };
    const kit = new ToolKit([makeTool('toolA', 'A', 'desc-a')]);
    const router = new EmbeddingRouter({ embedder, toolkit: kit, threshold: 0 });
    await router.pick('q');         // 1 tool + 1 query = 2 calls
    eq(embedCalls, 2);
    kit.add(makeTool('toolB', 'B', 'desc-b'));
    await router.pick('q');         // re-embed both tools + new query = 3 calls
    eq(embedCalls, 5);
  });
};
