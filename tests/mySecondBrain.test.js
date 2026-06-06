// MySecondBrain tests — the chat Q+A turn store (storeTurn / searchTurns).
//
// One row per turn (prompt + answer together), hybrid-searchable. The
// embedder isn't loadable in bare Node (it runs in a renderer worker), so
// storeTurn/searchTurns degrade to FTS-only here — which still proves the
// table, the two-column FTS index, prompt/answer round-trip, and metadata.
// Skipped entirely when better-sqlite3 can't load.

const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionIndex = require('../src/core/sessionIndex');
const { eq, ok, contains } = require('./assert');

function nativeModulesAreLoadable() {
  try {
    const tmp = path.join(os.tmpdir(), `myagent-msb-probe-${process.pid}.db`);
    const db = sessionIndex.open(tmp);
    db.close();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

async function withFreshDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-msb-'));
  const dbPath = path.join(dir, 'index.db');
  const db = sessionIndex.open(dbPath);
  try { await fn(db); }
  finally {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function run(t) {
  if (!nativeModulesAreLoadable()) {
    t.test('SKIP — MySecondBrain tests need a loadable better-sqlite3', async () => {});
    return;
  }

  t.test('storeTurn persists prompt + answer + metadata as one row', async () => {
    await withFreshDb(async (db) => {
      const r = await sessionIndex.storeTurn(db, {
        prompt: 'how do we deploy the project',
        answer: 'Run scripts/deploy.sh which pushes to fly.io after npm run build.',
        workerId: 'w1', provider: 'openrouter', model: 'openai/gpt-5-nano',
        conversationId: 'c1', tokensIn: 12, tokensOut: 40,
      });
      ok(r.id, 'returns a turn id');
      const row = db.prepare('SELECT * FROM MySecondBrain WHERE id = ?').get(r.id);
      eq(row.prompt, 'how do we deploy the project');
      contains(row.answer, 'fly.io');
      eq(row.worker_id, 'w1');
      eq(row.provider, 'openrouter');
      eq(row.model, 'openai/gpt-5-nano');
      eq(row.conversation_id, 'c1');
      eq(row.tokens_in, 12);
      eq(row.tokens_out, 40);
      ok(row.ts, 'has a timestamp');
    });
  });

  t.test('searchTurns finds a turn by ANSWER text (not just the prompt)', async () => {
    await withFreshDb(async (db) => {
      await sessionIndex.storeTurn(db, {
        prompt: 'how do we ship',
        answer: 'Deployment uses a blue-green strategy on Kubernetes via Argo.',
      });
      // Query a word that appears ONLY in the answer — the old two-row design
      // would miss this (the user row had no such word). The combined turn
      // makes it findable.
      const hits = await sessionIndex.searchTurns(db, 'Kubernetes Argo', { limit: 5 });
      eq(hits.length >= 1, true, 'found the turn via answer text');
      contains(hits[0].answer, 'Argo');
      contains(hits[0].prompt, 'how do we ship');
    });
  });

  t.test('searchTurns finds a turn by PROMPT text too', async () => {
    await withFreshDb(async (db) => {
      await sessionIndex.storeTurn(db, {
        prompt: 'remind me about the quarterly tax filing deadline',
        answer: 'Sure — noted.',
      });
      const hits = await sessionIndex.searchTurns(db, 'quarterly tax filing', { limit: 5 });
      eq(hits.length >= 1, true);
      contains(hits[0].prompt, 'tax filing');
    });
  });

  t.test('searchTurns returns prompt + answer separately AND a combined text', async () => {
    await withFreshDb(async (db) => {
      await sessionIndex.storeTurn(db, { prompt: 'what is the capital of France', answer: 'Paris.' });
      const hits = await sessionIndex.searchTurns(db, 'capital France', { limit: 5 });
      ok(hits.length >= 1);
      const h = hits[0];
      eq(typeof h.prompt, 'string');
      eq(typeof h.answer, 'string');
      contains(h.text, 'Q: what is the capital of France');
      contains(h.text, 'A: Paris.');
      eq(h.kind, 'turn');
    });
  });

  t.test('storeTurn stores prompt-only when answer is empty (aborted turn)', async () => {
    await withFreshDb(async (db) => {
      const r = await sessionIndex.storeTurn(db, { prompt: 'an unanswered question here', answer: '' });
      ok(r.id);
      const row = db.prepare('SELECT prompt, answer FROM MySecondBrain WHERE id = ?').get(r.id);
      eq(row.prompt, 'an unanswered question here');
      eq(row.answer, '');
    });
  });

  t.test('storeTurn rejects a turn with neither prompt nor answer', async () => {
    await withFreshDb(async (db) => {
      let threw = false;
      try { await sessionIndex.storeTurn(db, { prompt: '', answer: '' }); }
      catch { threw = true; }
      ok(threw, 'empty turn is rejected');
    });
  });

  t.test('deleteTurn removes the row, its FTS entry, and is no longer searchable', async () => {
    await withFreshDb(async (db) => {
      const r = await sessionIndex.storeTurn(db, {
        prompt: 'unique-deletion-marker zither', answer: 'gone soon',
      });
      let hits = await sessionIndex.searchTurns(db, 'zither', { limit: 5 });
      eq(hits.length >= 1, true, 'found before delete');
      const removed = sessionIndex.deleteTurn(db, r.id);
      eq(removed, true);
      hits = await sessionIndex.searchTurns(db, 'zither', { limit: 5 });
      eq(hits.length, 0, 'gone from search after delete');
      const row = db.prepare('SELECT id FROM MySecondBrain WHERE id = ?').get(r.id);
      eq(row, undefined, 'row deleted');
    });
  });

  t.test('searchTurns: minConfidence filters out weak semantic-only matches', async () => {
    await withFreshDb(async (db) => {
      await sessionIndex.storeTurn(db, { prompt: 'hello there', answer: 'general kenobi' });
      // Semantic (cosine) search returns SOME neighbor for any query, even an
      // unrelated one (a weak score). That's by design — the minConfidence
      // filter (default 0.5 in the real /memory-search path) is what hides
      // them. Without a threshold, an unrelated query may return a low-conf
      // hit; WITH one, it's filtered.
      const unfiltered = await sessionIndex.searchTurns(db, 'banana', { limit: 5 });
      ok(Array.isArray(unfiltered), 'returns an array, never throws');
      const filtered = await sessionIndex.searchTurns(db, 'banana', { minConfidence: 0.5 });
      eq(filtered.length, 0, 'a weak match is filtered out by minConfidence 0.5');
    });
  });

  t.test('confidence is absolute: a keyword hit is NOT auto-pinned to 1.0', async () => {
    await withFreshDb(async (db) => {
      // One turn → BM25 IDF is degenerate (every term in 100% of the corpus),
      // so a keyword query must NOT manufacture confidence 1.0 (the old
      // bm25/bestBm25 bug). Confidence should track the honest cosine instead.
      await sessionIndex.storeTurn(db, {
        prompt: 'build a markdown file with javascript syntax',
        answer: 'Created docs/javascript-basics.md with variables, functions, loops.',
      });
      const hits = await sessionIndex.searchTurns(db, 'javascript', { limit: 5 });
      eq(hits.length, 1);
      ok(hits[0].confidence < 0.99,
        `keyword hit must not be auto-1.0; got ${hits[0].confidence}`);
      ok(hits[0].confidence > 0, 'still a positive relevance');
    });
  });

  t.test('searchTurns: a strong match survives the minConfidence filter', async () => {
    await withFreshDb(async (db) => {
      await sessionIndex.storeTurn(db, {
        prompt: 'what is the deployment process',
        answer: 'We deploy with scripts/deploy.sh to fly.io.',
      });
      // An on-topic query should clear the bar (exact term → strong BM25).
      const hits = await sessionIndex.searchTurns(db, 'deployment process', { minConfidence: 0.5 });
      eq(hits.length >= 1, true, 'relevant turn survives the threshold');
      contains(hits[0].prompt, 'deployment process');
    });
  });
}

module.exports = { run };
