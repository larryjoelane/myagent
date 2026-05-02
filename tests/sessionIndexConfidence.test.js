// Confidence-scoring tests for sessionIndex.search. Designed against
// the spec in docs/memory-search.md ("Planned: Confidence Scoring").
//
// Skipped when better-sqlite3 isn't loadable in bare Node (the repo
// rebuilds it for Electron by default). Run `npm run rebuild:node`
// to enable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionIndex = require('../src/core/sessionIndex');
const { eq, ok, contains, deepEq } = require('./assert');

function nativeModulesAreLoadable() {
  try {
    const tmp = path.join(os.tmpdir(), `myagent-conf-probe-${process.pid}.db`);
    const db = sessionIndex.open(tmp);
    db.close();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

async function withFreshDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-conf-'));
  const dbPath = path.join(dir, 'index.db');
  const db = sessionIndex.open(dbPath);
  try { await fn(db); }
  finally {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function seed(db, texts) {
  for (let i = 0; i < texts.length; i++) {
    await sessionIndex.storeMemory(db, { text: texts[i], source: `t${i}` });
  }
}

function run(t) {
  if (!nativeModulesAreLoadable()) {
    t.test('SKIP — confidence tests need `npm run rebuild:node`', async () => {});
    return;
  }

  t.test('hits include raw cosine, raw bm25, and computed confidence', async () => {
    await withFreshDb(async (db) => {
      await seed(db, [
        'team prefers postgres over mysql for new services',
        'cats are nice and fluffy',
      ]);
      const hits = await sessionIndex.search(db, 'database preference', { limit: 5 });
      ok(hits.length >= 1, 'returned at least one hit');
      const top = hits[0];
      ok(typeof top.cosine === 'number', 'cosine is a number');
      ok(top.cosine >= 0 && top.cosine <= 1.001, `cosine in [0,1], got ${top.cosine}`);
      // bm25 may be null if FTS didn't match (likely here — query has
      // no exact tokens from the row). Accept null OR a negative
      // number (SQLite convention: lower is better).
      ok(top.bm25 === null || (typeof top.bm25 === 'number' && top.bm25 <= 0),
        `bm25 is null or negative, got ${top.bm25}`);
      ok(typeof top.confidence === 'number', 'confidence is a number');
      ok(top.confidence >= 0 && top.confidence <= 1.001,
        `confidence in [0,1], got ${top.confidence}`);
    });
  });

  t.test('pure cosine match: bm25 null, confidence equals cosine', async () => {
    await withFreshDb(async (db) => {
      // Row uses different vocabulary from the query — embedder should
      // still find the semantic link, but FTS5 won't match.
      await seed(db, [
        'the team prefers postgres over mysql for new services',
      ]);
      const hits = await sessionIndex.search(db, 'database preference', { limit: 5 });
      ok(hits.length === 1, 'one hit');
      const h = hits[0];
      eq(h.bm25, null, 'bm25 is null when FTS did not match');
      ok(h.cosine > 0.2, `cosine should reflect semantic match, got ${h.cosine}`);
      ok(Math.abs(h.confidence - Math.max(0, h.cosine)) < 0.001,
        `confidence should equal cosine when no FTS match (cosine=${h.cosine}, confidence=${h.confidence})`);
    });
  });

  t.test('FTS match rescues low-cosine identifier search (confidence high)', async () => {
    await withFreshDb(async (db) => {
      // Code-identifier corpus. Embeddings underperform on this kind
      // of token; FTS handles it well. Confidence should reflect FTS.
      await seed(db, [
        'function getUserById returns a user from the database',
        'unrelated content about weather forecasts',
      ]);
      const hits = await sessionIndex.search(db, 'getUserById', { limit: 5 });
      ok(hits.length >= 1);
      const match = hits.find((h) => h.text.includes('getUserById'));
      ok(match, 'identifier-bearing row was returned');
      ok(match.bm25 !== null, 'bm25 fired for FTS match');
      ok(match.bm25 < 0, 'bm25 is negative (lower=better)');
      // Even if cosine is weak, confidence should be high because of
      // the FTS rescue.
      ok(match.confidence >= 0.5,
        `confidence ≥ 0.5 even for identifier query, got ${match.confidence} (cosine=${match.cosine})`);
    });
  });

  t.test('confidence is always ≤ 1.0 for every hit (regression for inverted ratio bug)', async () => {
    await withFreshDb(async (db) => {
      // Multiple FTS-matching rows with varying BM25 scores. The
      // earlier formula (bestBm25 / rowBm25) gave non-best rows
      // values > 1 because both numbers are negative and best has
      // larger magnitude. Correct formula is rowBm25 / bestBm25.
      await seed(db, [
        'apple banana cherry date elderberry fig grape',
        'apple banana',
        'apple',
        'apple cherry',
        'apple banana grape',
      ]);
      const hits = await sessionIndex.search(db, 'apple banana cherry', { limit: 10 });
      ok(hits.length >= 3, 'multiple hits returned');
      for (const h of hits) {
        ok(h.confidence <= 1.0001,
          `confidence must be ≤ 1.0, got ${h.confidence} (cosine=${h.cosine}, bm25=${h.bm25})`);
        ok(h.confidence >= 0,
          `confidence must be ≥ 0, got ${h.confidence}`);
      }
    });
  });

  t.test('per-query BM25 normalization: best FTS hit has bm25 ratio 1.0', async () => {
    await withFreshDb(async (db) => {
      await seed(db, [
        'lorem ipsum lorem ipsum lorem ipsum lorem ipsum',
        'lorem ipsum lorem',
        'lorem',
      ]);
      const hits = await sessionIndex.search(db, 'lorem ipsum', { limit: 10 });
      const ftsHits = hits.filter((h) => h.bm25 !== null);
      ok(ftsHits.length >= 2, 'multiple FTS-matching rows');
      // best_bm25 is the most-negative number; expose it for assertion
      // by reading from the search result's __bm25Best (test hook), or
      // re-derive from raw bm25 values.
      const bestBm25 = Math.min(...ftsHits.map((h) => h.bm25));
      // For the row with bestBm25, the bm25-normalized component should
      // equal 1.0. For others, it should be < 1.0. Confidence is the
      // max of cosine_norm and bm25_norm, so we can't read bm25_norm
      // directly — but we can assert the row at bestBm25 has
      // confidence ≥ 0.999.
      const bestRow = ftsHits.find((h) => h.bm25 === bestBm25);
      ok(bestRow.confidence >= 0.999,
        `best-BM25 row should have confidence ≈ 1.0, got ${bestRow.confidence}`);
    });
  });

  t.test('minConfidence filters out low-confidence rows', async () => {
    await withFreshDb(async (db) => {
      await seed(db, [
        'this row exactly matches the query terms',
        'random unrelated content here',
      ]);
      // No threshold: should return both (top-N behavior).
      const all = await sessionIndex.search(db, 'matches the query', { limit: 5 });
      ok(all.length >= 1);
      // Threshold: should filter to only high-confidence rows.
      const filtered = await sessionIndex.search(db, 'matches the query', {
        limit: 5, minConfidence: 0.5,
      });
      ok(filtered.length <= all.length, 'filtered ≤ unfiltered');
      for (const h of filtered) {
        ok(h.confidence >= 0.5, `each hit has confidence ≥ 0.5, got ${h.confidence}`);
      }
    });
  });

  t.test('minConfidence with no limit returns all qualifying rows', async () => {
    await withFreshDb(async (db) => {
      // 30 rows that should all match a high-confidence threshold.
      const same = 'identical content for testing high confidence';
      await seed(db, Array(30).fill(same));
      const hits = await sessionIndex.search(db, same, { minConfidence: 0.5 });
      // Without explicit limit, default applies but minConfidence
      // should relax it to scan the full index. Doc says "all rows ≥
      // threshold, no count cap by default."
      ok(hits.length >= 20, `expected most matching rows; got ${hits.length}`);
      for (const h of hits) {
        ok(h.confidence >= 0.5);
      }
    });
  });
}

module.exports = { run };
