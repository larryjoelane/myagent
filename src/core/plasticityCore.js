// plasticityCore.js — the neuroplasticity logic, with NO database dependency.
//
// Why this exists: the same energy/firing/spreading/snapshot logic must run in
// two very different places —
//   • locally, on better-sqlite3 (synchronous, Node native module), and
//   • in a Cloudflare Worker, on D1 (asynchronous, env.DB.prepare().bind()).
// Mixing SQL into the logic forced a copy-paste fork. Instead, this module is
// PURE: it computes *what* to read/write and *how* to score, taking plain rows
// in and returning plain data out. The thin per-driver adapters (in
// sessionIndex.js for better-sqlite3; in the Worker for D1) do the actual SQL.
//
// Nothing here imports a driver, touches the filesystem, or calls Date.now()
// implicitly — callers pass `nowMs` so behaviour is deterministic + testable.
//
// Contract shapes (plain objects, driver-agnostic):
//   neuron row : { turn_id, retrieval_count, last_retrieved_ts }
//   edge row   : { turn_a, turn_b, weight }      (stored turn_a < turn_b)
//   turn row   : { id, prompt, answer, ts, retrieval_count?, last_retrieved_ts? }

// ── Tunables (single source of truth; previously duplicated in sessionIndex) ──
const ENERGY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // recency half-life ~14d
const FREQ_SATURATION_K = 4;          // retrieval_count saturation constant
const RECENCY_WEIGHT = 0.6;           // energy = RECENCY*recency + FREQUENCY*freq
const FREQUENCY_WEIGHT = 0.4;
const ENERGY_RANK_AMPLITUDE = 0.35;   // energy nudges rank within [1-A, 1+A]
const SPREAD_FACTOR = 0.25;           // fraction of a hit's score that cascades
const SPREAD_WEIGHT_NORM = 5;         // edge-weight normaliser for spreading
const DEFAULT_MIN_FIRING_CONFIDENCE = 0.4; // reinforcement floor

const TUNABLES = {
  ENERGY_HALF_LIFE_MS, FREQ_SATURATION_K, RECENCY_WEIGHT, FREQUENCY_WEIGHT,
  ENERGY_RANK_AMPLITUDE, SPREAD_FACTOR, SPREAD_WEIGHT_NORM,
  DEFAULT_MIN_FIRING_CONFIDENCE,
};

// ── Pure scoring ────────────────────────────────────────────────────────────

// [0,1] energy from a neuron's frequency + recency at time `nowMs`. A turn
// never retrieved (no neuron row / no timestamp) returns the neutral baseline
// 0.5 — neither boosted nor penalized until it participates in a firing.
function neuronEnergy(neuron, nowMs) {
  if (!neuron || !neuron.last_retrieved_ts) return 0.5;
  const last = Date.parse(neuron.last_retrieved_ts);
  const recency = Number.isFinite(last)
    ? Math.pow(2, -(nowMs - last) / ENERGY_HALF_LIFE_MS)
    : 0.5;
  const freq = 1 - Math.exp(-(neuron.retrieval_count || 0) / FREQ_SATURATION_K);
  return RECENCY_WEIGHT * recency + FREQUENCY_WEIGHT * freq;
}

// Map energy in [0,1] to a rank multiplier in [1-AMP, 1+AMP], centered so the
// neutral 0.5 baseline is a no-op (×1.0).
function energyMultiplier(energy) {
  return 1 + ENERGY_RANK_AMPLITUDE * (2 * energy - 1);
}

// ── Firing combinatorics (what to write — the driver runs the writes) ────────

// Normalize a list of turn ids fired together into the deduped, integer-only set.
function firingIds(turnIds) {
  return [...new Set((turnIds || []).filter((n) => Number.isInteger(n)))];
}

// The unordered pairs (turn_a < turn_b) to strengthen for a co-fired set. The
// driver inserts/increments an edge per pair. Empty for < 2 ids.
function firingPairs(turnIds) {
  const ids = firingIds(turnIds);
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      pairs.push([Math.min(ids[i], ids[j]), Math.max(ids[i], ids[j])]);
    }
  }
  return pairs;
}

// Filter a result set to the ids that clear the reinforcement floor — only
// these get fired (shown ≠ learned). `hits` are objects with a `confidence`.
function firingTargets(hits, minFiringConfidence = DEFAULT_MIN_FIRING_CONFIDENCE) {
  return (hits || [])
    .filter((h) => typeof h.confidence === 'number' && h.confidence >= minFiringConfidence)
    .map((h) => h.id)
    .filter((n) => Number.isInteger(n));
}

// ── Spreading activation (given edges already fetched by the driver) ─────────

// Cascade a fraction of each direct hit's score to its wired neighbours.
//   edges            : array of { turn_a, turn_b, weight } touching the hits
//   directScoreById  : Map(id -> relevance score) of the direct hits
//   spreadFactor     : fraction of a hit's score that cascades to a wired
//                      neighbour. Defaults to SPREAD_FACTOR; the UI's
//                      "Spread strength" slider overrides it per-search.
// Returns Map(neighbourId -> boost) for neighbours NOT among the direct hits.
function computeSpread(edges, directScoreById, spreadFactor = SPREAD_FACTOR) {
  const factor = (Number.isFinite(spreadFactor) && spreadFactor >= 0) ? spreadFactor : SPREAD_FACTOR;
  const boost = new Map();
  const direct = new Set(directScoreById.keys());
  for (const e of edges || []) {
    let hit; let neighbour;
    if (direct.has(e.turn_a) && !direct.has(e.turn_b)) { hit = e.turn_a; neighbour = e.turn_b; }
    else if (direct.has(e.turn_b) && !direct.has(e.turn_a)) { hit = e.turn_b; neighbour = e.turn_a; }
    else continue;
    const hitScore = directScoreById.get(hit) || 0;
    const w = Math.min(1, (e.weight || 0) / SPREAD_WEIGHT_NORM);
    boost.set(neighbour, (boost.get(neighbour) || 0) + hitScore * factor * w);
  }
  return boost;
}

// ── Snapshot assembly (given rows already fetched by the driver) ─────────────

// Short on-canvas label handle; full prompt stays available on hover.
function snapshotLabel(prompt, max = 48) {
  const s = String(prompt || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Build the renderer-agnostic graph snapshot from already-fetched rows.
//   turnRows : [{ id, prompt, answer, ts, retrieval_count, last_retrieved_ts }]
//   edgeRows : [{ turn_a, turn_b, weight }]
//   opts     : { limit=200, minEnergy=0, includeIsolated=true, nowMs }
// Pure — does no IO. Same output shape the local graphSnapshot() returned.
function buildSnapshot(turnRows, edgeRows, opts = {}) {
  const {
    limit = 200, minEnergy = 0, includeIsolated = true,
    nowMs = 0,
  } = opts;

  let nodes = (turnRows || []).map((t) => {
    const energy = neuronEnergy(
      { retrieval_count: t.retrieval_count, last_retrieved_ts: t.last_retrieved_ts },
      nowMs,
    );
    const prompt = String(t.prompt || '');
    return {
      id: t.id,
      label: snapshotLabel(prompt),
      prompt,
      answer: String(t.answer || ''),
      energy,
      retrievalCount: t.retrieval_count || 0,
      lastRetrieved: t.last_retrieved_ts || null,
      ts: t.ts,
    };
  });

  if (minEnergy > 0) nodes = nodes.filter((n) => n.energy >= minEnergy);
  nodes.sort((a, b) => b.energy - a.energy);
  if (nodes.length > limit) nodes = nodes.slice(0, limit);

  const keep = new Set(nodes.map((n) => n.id));
  const edges = (edgeRows || [])
    .filter((e) => keep.has(e.turn_a) && keep.has(e.turn_b))
    .map((e) => ({ id: `${e.turn_a}-${e.turn_b}`, source: e.turn_a, target: e.turn_b, weight: e.weight }));

  if (!includeIsolated) {
    const connected = new Set();
    for (const e of edges) { connected.add(e.source); connected.add(e.target); }
    nodes = nodes.filter((n) => connected.has(n.id));
  }

  const energies = nodes.map((n) => n.energy);
  const weights = edges.map((e) => e.weight);
  return {
    nodes,
    edges,
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      energyMin: energies.length ? Math.min(...energies) : 0,
      energyMax: energies.length ? Math.max(...energies) : 0,
      weightMax: weights.length ? Math.max(...weights) : 0,
      generatedAt: new Date(nowMs).toISOString(),
    },
  };
}

module.exports = {
  TUNABLES,
  // scoring
  neuronEnergy,
  energyMultiplier,
  // firing
  firingIds,
  firingPairs,
  firingTargets,
  // spreading
  computeSpread,
  // snapshot
  snapshotLabel,
  buildSnapshot,
};
