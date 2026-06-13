// plasticityCore tests — the PURE, driver-agnostic plasticity logic.
//
// These exercise the core with NO database at all (plain objects in, plain
// data out), proving it can run anywhere — the local better-sqlite3 adapter
// AND the Cloudflare Worker's D1 adapter both delegate to this exact module.
// If these pass, the Worker's firing/energy/snapshot behaviour is guaranteed
// to match local without a DB in the loop.

const core = require('../src/core/plasticityCore');
const { eq, ok, deepEq } = require('./assert');

function run(t) {
  // ── energy + multiplier (mirrors the sessionIndex tests, but DB-free) ──
  t.test('neuronEnergy: null/never-fired → 0.5; fresh+frequent → high; stale → low', () => {
    const now = Date.parse('2026-06-07T00:00:00.000Z');
    eq(core.neuronEnergy(null, now), 0.5);
    eq(core.neuronEnergy({ retrieval_count: 0, last_retrieved_ts: null }, now), 0.5);
    const hot = core.neuronEnergy({ retrieval_count: 10, last_retrieved_ts: '2026-06-07T00:00:00.000Z' }, now);
    ok(hot > 0.9, `fresh+frequent hot, got ${hot}`);
    const cold = core.neuronEnergy({ retrieval_count: 1, last_retrieved_ts: '2026-03-01T00:00:00.000Z' }, now);
    ok(cold < hot, 'stale < fresh');
  });

  t.test('energyMultiplier: 0.5 → 1.0; hot >1; cold <1', () => {
    ok(Math.abs(core.energyMultiplier(0.5) - 1) < 1e-9);
    ok(core.energyMultiplier(1) > 1);
    ok(core.energyMultiplier(0) < 1);
  });

  // ── firing combinatorics ──
  t.test('firingIds: dedups and keeps integers only', () => {
    deepEq(core.firingIds([1, 1, 2, 3, 3]), [1, 2, 3]);
    deepEq(core.firingIds([1, 'x', null, 2.5, 2]), [1, 2]);
    deepEq(core.firingIds([]), []);
  });

  t.test('firingPairs: all unordered pairs normalized a<b; empty for <2 ids', () => {
    const pairs = core.firingPairs([1, 2, 3]);
    eq(pairs.length, 3, 'three pairs among three ids');
    ok(pairs.every(([a, b]) => a < b), 'every pair normalized a<b');
    // Canonicalize to a comparable set regardless of array order.
    const key = (p) => p.map(([a, b]) => `${a}-${b}`).sort().join(',');
    eq(key(pairs), '1-2,1-3,2-3');
    // Dedup happens first: [3,1,3,1] → ids {1,3} → one pair.
    eq(key(core.firingPairs([3, 1, 3, 1])), '1-3');
    eq(core.firingPairs([5]).length, 0, 'single id → no pairs');
    eq(core.firingPairs([]).length, 0);
  });

  t.test('firingTargets: only hits clearing the floor are fired', () => {
    const hits = [
      { id: 1, confidence: 0.81 },  // strong → fire
      { id: 2, confidence: 0.02 },  // weak  → not fired
      { id: 3, confidence: 0.4 },   // exactly floor → fire (>=)
      { id: 4 },                    // no confidence → not fired
    ];
    deepEq(core.firingTargets(hits, 0.4), [1, 3]);
    // Floor 0 fires everything that has a numeric confidence.
    deepEq(core.firingTargets(hits, 0), [1, 2, 3]);
    // Default floor is 0.4 (the tunable).
    deepEq(core.firingTargets(hits), [1, 3]);
  });

  // ── spreading activation ──
  t.test('computeSpread: cascades to neighbours, not to direct hits', () => {
    const edges = [
      { turn_a: 1, turn_b: 2, weight: 5 }, // 1 (hit) -> 2 (neighbour), strong
      { turn_a: 1, turn_b: 3, weight: 1 }, // 1 (hit) -> 3 (neighbour), weak
      { turn_a: 1, turn_b: 4, weight: 9 }, // 4 is ALSO a direct hit → no spread
    ];
    const directScoreById = new Map([[1, 1.0], [4, 0.5]]);
    const boost = core.computeSpread(edges, directScoreById);
    ok(boost.has(2) && boost.get(2) > 0, 'strong neighbour boosted');
    ok(boost.has(3) && boost.get(3) > 0, 'weak neighbour boosted');
    ok(boost.get(2) > boost.get(3), 'stronger synapse → bigger boost');
    eq(boost.has(1), false, 'direct hit not self-boosted');
    eq(boost.has(4), false, 'edge between two direct hits does not spread');
  });

  t.test('computeSpread: empty edges → empty boost', () => {
    eq(core.computeSpread([], new Map([[1, 1]])).size, 0);
    eq(core.computeSpread(null, new Map([[1, 1]])).size, 0);
  });

  // ── snapshot assembly (the shape the viewer + Worker both consume) ──
  t.test('buildSnapshot: nodes carry energy, edges carry weight, meta summarizes', () => {
    const nowMs = Date.parse('2026-06-07T00:00:00.000Z');
    const turnRows = [
      { id: 1, prompt: 'alpha', answer: 'a', ts: 't', retrieval_count: 2, last_retrieved_ts: '2026-06-07T00:00:00.000Z' },
      { id: 2, prompt: 'beta', answer: 'b', ts: 't', retrieval_count: 2, last_retrieved_ts: '2026-06-07T00:00:00.000Z' },
      { id: 3, prompt: 'cold', answer: 'c', ts: 't', retrieval_count: 0, last_retrieved_ts: null },
    ];
    const edgeRows = [{ turn_a: 1, turn_b: 2, weight: 2 }];
    const snap = core.buildSnapshot(turnRows, edgeRows, { nowMs });
    eq(snap.nodes.length, 3);
    eq(snap.meta.nodeCount, 3);
    const byId = new Map(snap.nodes.map((n) => [n.id, n]));
    ok(byId.get(1).energy > 0.5, 'fired node hot');
    eq(byId.get(3).energy, 0.5, 'never-fired node neutral');
    eq(snap.edges.length, 1);
    eq(snap.edges[0].weight, 2);
    eq(snap.edges[0].source, 1);
    eq(snap.edges[0].target, 2);
    eq(snap.meta.weightMax, 2);
  });

  t.test('buildSnapshot: minEnergy + includeIsolated:false drop the cold isolated node', () => {
    const nowMs = Date.parse('2026-06-07T00:00:00.000Z');
    const turnRows = [
      { id: 1, prompt: 'h1', retrieval_count: 1, last_retrieved_ts: '2026-06-07T00:00:00.000Z' },
      { id: 2, prompt: 'h2', retrieval_count: 1, last_retrieved_ts: '2026-06-07T00:00:00.000Z' },
      { id: 3, prompt: 'cold', retrieval_count: 0, last_retrieved_ts: null },
    ];
    const edgeRows = [{ turn_a: 1, turn_b: 2, weight: 1 }];
    eq(core.buildSnapshot(turnRows, edgeRows, { nowMs, minEnergy: 0.55 }).nodes.length, 2);
    eq(core.buildSnapshot(turnRows, edgeRows, { nowMs, includeIsolated: false }).nodes.length, 2);
  });

  t.test('buildSnapshot: limit keeps the most-vital nodes', () => {
    const nowMs = Date.parse('2026-06-07T00:00:00.000Z');
    const turnRows = [
      { id: 1, prompt: 'hot', retrieval_count: 9, last_retrieved_ts: '2026-06-07T00:00:00.000Z' },
      { id: 2, prompt: 'mid', retrieval_count: 1, last_retrieved_ts: '2026-06-07T00:00:00.000Z' },
      { id: 3, prompt: 'cold', retrieval_count: 0, last_retrieved_ts: null },
    ];
    const snap = core.buildSnapshot(turnRows, [], { nowMs, limit: 1 });
    eq(snap.nodes.length, 1);
    eq(snap.nodes[0].id, 1, 'kept the hottest node');
  });

  t.test('TUNABLES are exported (single source of truth)', () => {
    ok(typeof core.TUNABLES.DEFAULT_MIN_FIRING_CONFIDENCE === 'number');
    ok(typeof core.TUNABLES.SPREAD_FACTOR === 'number');
    ok(typeof core.TUNABLES.ENERGY_HALF_LIFE_MS === 'number');
  });
}

module.exports = { run };
