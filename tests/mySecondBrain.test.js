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

  // ── Neuroplasticity layer ───────────────────────────────────────────────

  t.test('neuronEnergy: never-retrieved → neutral 0.5; fresh+frequent → high; stale → low', () => {
    const now = Date.parse('2026-06-06T00:00:00.000Z');
    // No neuron row at all → neutral baseline.
    eq(sessionIndex.neuronEnergy(null, now), 0.5);
    eq(sessionIndex.neuronEnergy({ retrieval_count: 0, last_retrieved_ts: null }, now), 0.5);
    // Retrieved just now, many times → high energy (recency≈1, freq high).
    const hot = sessionIndex.neuronEnergy(
      { retrieval_count: 10, last_retrieved_ts: '2026-06-06T00:00:00.000Z' }, now);
    ok(hot > 0.9, `fresh+frequent should be hot, got ${hot}`);
    // Retrieved once, long ago (~3 months) → recency decayed away → low.
    const cold = sessionIndex.neuronEnergy(
      { retrieval_count: 1, last_retrieved_ts: '2026-03-01T00:00:00.000Z' }, now);
    ok(cold < hot, 'stale memory has lower energy than a fresh one');
  });

  t.test('energyMultiplier: neutral 0.5 → ×1.0; hot >1; cold <1', () => {
    eq(Math.abs(sessionIndex.energyMultiplier(0.5) - 1) < 1e-9, true, 'baseline is a no-op');
    ok(sessionIndex.energyMultiplier(1.0) > 1, 'max energy boosts');
    ok(sessionIndex.energyMultiplier(0.0) < 1, 'zero energy penalizes');
  });

  t.test('recordFiring: bumps retrieval_count and wires Hebbian edges among the set', async () => {
    await withFreshDb(async (db) => {
      const a = (await sessionIndex.storeTurn(db, { prompt: 'turn A', answer: 'aaa' })).id;
      const b = (await sessionIndex.storeTurn(db, { prompt: 'turn B', answer: 'bbb' })).id;
      const c = (await sessionIndex.storeTurn(db, { prompt: 'turn C', answer: 'ccc' })).id;
      sessionIndex.recordFiring(db, [a, b, c], '2026-06-06T00:00:00.000Z');
      // Neurons: each retrieved once.
      const neurons = sessionIndex.loadNeurons(db, [a, b, c]);
      eq(neurons.get(a).retrieval_count, 1);
      eq(neurons.get(c).retrieval_count, 1);
      // Edges: all 3 unordered pairs exist with weight 1 (stored a<b).
      const edgeCount = db.prepare('SELECT COUNT(*) AS n FROM msb_edge').get().n;
      eq(edgeCount, 3, 'three pairs among three co-fired turns');
      // Fire A+B again → their edge strengthens to 2, count bumps to 2.
      sessionIndex.recordFiring(db, [a, b], '2026-06-07T00:00:00.000Z');
      const lo = Math.min(a, b); const hi = Math.max(a, b);
      const w = db.prepare('SELECT weight FROM msb_edge WHERE turn_a = ? AND turn_b = ?').get(lo, hi).weight;
      eq(w, 2, 'repeated co-retrieval strengthens the synapse');
      eq(sessionIndex.loadNeurons(db, [a]).get(a).retrieval_count, 2);
    });
  });

  t.test('searchTurns records a firing for the turns it returns (retrieval = a firing)', async () => {
    await withFreshDb(async (db) => {
      const id = (await sessionIndex.storeTurn(db, {
        prompt: 'how does vulkan fallback work', answer: 'It uses the Intel GPU.',
      })).id;
      // Before any search, no neuron row.
      eq(sessionIndex.loadNeurons(db, [id]).size, 0, 'no neuron until retrieved');
      await sessionIndex.searchTurns(db, 'vulkan fallback', { limit: 5 });
      const n = sessionIndex.loadNeurons(db, [id]).get(id);
      ok(n, 'a neuron row exists after the turn is retrieved');
      eq(n.retrieval_count, 1, 'retrieval counted as one firing');
      ok(n.last_retrieved_ts, 'last_retrieved_ts stamped');
      // A second matching search bumps the count.
      await sessionIndex.searchTurns(db, 'vulkan fallback', { limit: 5 });
      eq(sessionIndex.loadNeurons(db, [id]).get(id).retrieval_count, 2);
    });
  });

  t.test('plasticity:false leaves the store untouched (no neuron written)', async () => {
    await withFreshDb(async (db) => {
      const id = (await sessionIndex.storeTurn(db, { prompt: 'opt out test', answer: 'xyz' })).id;
      await sessionIndex.searchTurns(db, 'opt out test', { limit: 5, plasticity: false });
      eq(sessionIndex.loadNeurons(db, [id]).size, 0, 'no firing recorded when opted out');
    });
  });

  t.test('minFiringConfidence: a weak hit is SHOWN but NOT fired (no graph pollution)', async () => {
    await withFreshDb(async (db) => {
      const onTopic = (await sessionIndex.storeTurn(db, {
        prompt: 'how does vulkan fallback work', answer: 'It uses the Intel GPU.',
      })).id;
      const offTopic = (await sessionIndex.storeTurn(db, {
        prompt: 'unrelated banana recipe', answer: 'mash the banana',
      })).id;
      // Unfiltered query (minConfidence 0): the off-topic turn rides along in
      // the result set with near-zero confidence. It must be RETURNED (display
      // is permissive) but NOT fired (learning is conservative).
      const hits = await sessionIndex.searchTurns(db, 'vulkan', { limit: 5 });
      const ids = hits.map((h) => h.id);
      eq(ids.includes(onTopic), true, 'on-topic turn returned');
      // The on-topic turn cleared the firing floor → has a neuron.
      ok(sessionIndex.loadNeurons(db, [onTopic]).has(onTopic), 'strong hit fired');
      // The off-topic banana turn (confidence ~0) did NOT fire → no neuron, so
      // it never gets wired to the vulkan turn. This is the pollution guard.
      eq(sessionIndex.loadNeurons(db, [offTopic]).size, 0, 'weak hit not fired');
      eq(db.prepare('SELECT COUNT(*) AS n FROM msb_edge').get().n, 0,
        'no spurious synapse between strong and weak co-results');
    });
  });

  t.test('minFiringConfidence: 0 restores fire-everything (explicit opt back in)', async () => {
    await withFreshDb(async (db) => {
      const onTopic = (await sessionIndex.storeTurn(db, {
        prompt: 'how does vulkan fallback work', answer: 'It uses the Intel GPU.',
      })).id;
      const offTopic = (await sessionIndex.storeTurn(db, {
        prompt: 'unrelated banana recipe', answer: 'mash the banana',
      })).id;
      await sessionIndex.searchTurns(db, 'vulkan', { limit: 5, minFiringConfidence: 0 });
      // With the floor dropped, even the weak banana co-result fires + wires.
      ok(sessionIndex.loadNeurons(db, [offTopic]).has(offTopic), 'weak hit fires when floor is 0');
      ok(db.prepare('SELECT COUNT(*) AS n FROM msb_edge').get().n >= 1,
        'edge formed between co-results when floor is 0');
    });
  });

  t.test('spreadingBoost: a co-fired neighbour gets an associative boost', async () => {
    await withFreshDb(async (db) => {
      const a = (await sessionIndex.storeTurn(db, { prompt: 'alpha', answer: 'one' })).id;
      const b = (await sessionIndex.storeTurn(db, { prompt: 'beta', answer: 'two' })).id;
      // Wire a<->b by co-firing them several times (strong synapse).
      for (let i = 0; i < 3; i += 1) sessionIndex.recordFiring(db, [a, b], '2026-06-06T00:00:00.000Z');
      // A query that DIRECTLY hits only `a` should spread some score to `b`.
      const boost = sessionIndex.spreadingBoost(db, new Map([[a, 1.0]]));
      ok(boost.has(b), 'neighbour b receives spreading activation');
      ok(boost.get(b) > 0, `boost is positive, got ${boost.get(b)}`);
      // The direct hit itself is NOT in the boost map (it has its own score).
      eq(boost.has(a), false, 'direct hit does not boost itself');
    });
  });

  t.test('graphSnapshot: returns nodes (with energy) + edges (with weight) + meta', async () => {
    await withFreshDb(async (db) => {
      const a = (await sessionIndex.storeTurn(db, { prompt: 'alpha topic', answer: 'a' })).id;
      const b = (await sessionIndex.storeTurn(db, { prompt: 'beta topic', answer: 'b' })).id;
      const c = (await sessionIndex.storeTurn(db, { prompt: 'cold never fired', answer: 'c' })).id;
      // Fire a+b together twice → both get neurons, one edge weight 2.
      const nowIso = '2026-06-07T00:00:00.000Z';
      sessionIndex.recordFiring(db, [a, b], nowIso);
      sessionIndex.recordFiring(db, [a, b], nowIso);
      const nowMs = Date.parse(nowIso);
      const snap = sessionIndex.graphSnapshot(db, { nowMs });
      // 3 nodes, all present (isolated cold node kept by default).
      eq(snap.nodes.length, 3);
      eq(snap.meta.nodeCount, 3);
      const byId = new Map(snap.nodes.map((n) => [n.id, n]));
      // Fired nodes are hotter than the never-fired one (neutral 0.5).
      ok(byId.get(a).energy > 0.5, 'fired node is above baseline');
      eq(byId.get(c).energy, 0.5, 'never-fired node sits at neutral 0.5');
      eq(byId.get(a).retrievalCount, 2);
      // One edge a<->b with weight 2.
      eq(snap.edges.length, 1);
      eq(snap.edges[0].weight, 2);
      eq(snap.edges[0].source, Math.min(a, b));
      eq(snap.edges[0].target, Math.max(a, b));
      eq(snap.meta.weightMax, 2);
      // Label is the (truncated) prompt; full prompt/answer also present.
      ok(byId.get(a).label.includes('alpha'));
      eq(byId.get(a).prompt, 'alpha topic');
    });
  });

  t.test('graphSnapshot: minEnergy drops cold nodes; includeIsolated:false drops unwired', async () => {
    await withFreshDb(async (db) => {
      const a = (await sessionIndex.storeTurn(db, { prompt: 'hot one', answer: 'a' })).id;
      const b = (await sessionIndex.storeTurn(db, { prompt: 'hot two', answer: 'b' })).id;
      await sessionIndex.storeTurn(db, { prompt: 'cold lonely', answer: 'c' }); // never fired, isolated
      const nowIso = '2026-06-07T00:00:00.000Z';
      sessionIndex.recordFiring(db, [a, b], nowIso);
      const nowMs = Date.parse(nowIso);
      // minEnergy above 0.5 drops the never-fired cold node.
      const snap1 = sessionIndex.graphSnapshot(db, { nowMs, minEnergy: 0.55 });
      eq(snap1.nodes.length, 2, 'cold node filtered by minEnergy');
      // includeIsolated:false also drops it (it has no edges).
      const snap2 = sessionIndex.graphSnapshot(db, { nowMs, includeIsolated: false });
      eq(snap2.nodes.length, 2, 'isolated cold node dropped');
      ok(snap2.nodes.every((n) => n.id === a || n.id === b));
    });
  });

  t.test('graphSnapshot: never mutates (pure read — no firing side effect)', async () => {
    await withFreshDb(async (db) => {
      const id = (await sessionIndex.storeTurn(db, { prompt: 'read only check', answer: 'x' })).id;
      sessionIndex.graphSnapshot(db);
      eq(sessionIndex.loadNeurons(db, [id]).size, 0, 'snapshot did not fire anything');
    });
  });

  t.test('edges are swept when a turn is deleted (CASCADE)', async () => {
    await withFreshDb(async (db) => {
      const a = (await sessionIndex.storeTurn(db, { prompt: 'keepme', answer: 'k' })).id;
      const b = (await sessionIndex.storeTurn(db, { prompt: 'deleteme zarf', answer: 'd' })).id;
      sessionIndex.recordFiring(db, [a, b], '2026-06-06T00:00:00.000Z');
      eq(db.prepare('SELECT COUNT(*) AS n FROM msb_edge').get().n, 1);
      sessionIndex.deleteTurn(db, b);
      eq(db.prepare('SELECT COUNT(*) AS n FROM msb_edge').get().n, 0, 'synapse swept with the neuron');
      eq(sessionIndex.loadNeurons(db, [b]).size, 0, 'neuron row gone too');
    });
  });
}

module.exports = { run };
