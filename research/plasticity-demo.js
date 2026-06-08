// plasticity-demo.js — observe the neuroplasticity layer on a real DB.
//
// Self-contained: opens a throwaway SQLite index, seeds a handful of chat
// turns, fires a sequence of queries, and prints how neuron energy and
// Hebbian edges evolve. Runs FTS-only (the embedder lives in the renderer
// worker, not bare Node) — which is fine: the plasticity layer is independent
// of the embedder, and FTS gives deterministic matches for a demo.
//
// Run:  node research/plasticity-demo.js
//
// This is a research/observability script, not a test. It writes its findings
// to stdout; the companion report (plasticity-behavior-report.md) captures a
// representative run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionIndex = require('../src/core/sessionIndex');

function bar(x, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(x * width)));
  return '█'.repeat(n) + '·'.repeat(width - n);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plasticity-demo-'));
  const db = sessionIndex.open(path.join(dir, 'index.db'));
  const nowMs = Date.now();

  // ── Seed: 6 turns across 3 loose topics ────────────────────────────────
  const seed = [
    { prompt: 'how does the vulkan fallback work on intel',          answer: 'llama.cpp uses the Vulkan backend on the Intel GPU; CPU fallback otherwise.' },
    { prompt: 'which gguf model fits 8gb vram',                       answer: 'Qwen2.5-Coder-7B Q4_K_M is 4.68GB and fits with room for KV cache.' },
    { prompt: 'can we constrain the model output format',            answer: 'Yes — GBNF grammar constrains decoding so invalid tokens cannot be sampled.' },
    { prompt: 'how should we weigh decayed memories',                answer: 'Rank by energy (recency x frequency), do not delete them.' },
    { prompt: 'what is spreading activation in the memory graph',     answer: 'A hit cascades score to wired neighbours — associative recall.' },
    { prompt: 'remind me about the quarterly tax filing deadline',    answer: 'Noted — unrelated to the model work.' },
  ];
  const ids = {};
  for (const s of seed) {
    const r = await sessionIndex.storeTurn(db, s);
    ids[r.id] = s.prompt;
  }
  console.log(`Seeded ${seed.length} turns into ${path.basename(dir)}\n`);

  // ── A query script: the user keeps returning to the local-model topic, ──
  // ── touches memory once, and never asks about taxes again. ──────────────
  const queries = [
    'vulkan intel gpu',          // hits turn 1
    'gguf model 8gb',            // hits turn 2  -> wires 1?no (separate query)
    'vulkan fallback model',     // hits 1 (and maybe 2) -> co-fire
    'grammar constrain output',  // hits turn 3
    'vulkan model gguf grammar', // hits 1,2,3 together -> strong co-firing
    'spreading activation memory',// hits turn 5
  ];

  console.log('Firing queries (each retrieval reinforces the turns it returns):\n');
  for (const q of queries) {
    const hits = await sessionIndex.searchTurns(db, q, { limit: 3 });
    const hitIds = hits.map((h) => h.id);
    console.log(`  q="${q}"  ->  turns [${hitIds.join(', ')}]`);
  }
  console.log('');

  // ── Report: neuron vitality ────────────────────────────────────────────
  const allIds = Object.keys(ids).map(Number);
  const neurons = sessionIndex.loadNeurons(db, allIds);
  console.log('NEURON ENERGY (recency x frequency), higher = more vital:\n');
  const rows = allIds.map((id) => {
    const n = neurons.get(id);
    const energy = sessionIndex.neuronEnergy(n, nowMs);
    const mult = sessionIndex.energyMultiplier(energy);
    return { id, count: n ? n.retrieval_count : 0, energy, mult, prompt: ids[id] };
  }).sort((a, b) => b.energy - a.energy);
  for (const r of rows) {
    console.log(
      `  #${r.id}  ${bar(r.energy)}  E=${r.energy.toFixed(2)}  x${r.mult.toFixed(2)}  `
      + `recalls=${r.count}   ${r.prompt.slice(0, 42)}`,
    );
  }

  // ── Report: Hebbian edges (the wiring) ─────────────────────────────────
  console.log('\nHEBBIAN EDGES (co-retrieval weight), the associative graph:\n');
  const edges = db.prepare('SELECT turn_a, turn_b, weight FROM msb_edge ORDER BY weight DESC').all();
  if (edges.length === 0) console.log('  (none)');
  for (const e of edges) {
    console.log(`  #${e.turn_a} <-> #${e.turn_b}   w=${e.weight}   ${bar(Math.min(1, e.weight / 5), 12)}`);
  }

  // ── Report: spreading activation in action ─────────────────────────────
  console.log('\nSPREADING ACTIVATION — query directly hits ONE turn, who else lights up:\n');
  // Pick the most-wired turn as the direct hit.
  const topHit = rows.find((r) => edges.some((e) => e.turn_a === r.id || e.turn_b === r.id));
  if (topHit) {
    const boost = sessionIndex.spreadingBoost(db, new Map([[topHit.id, 1.0]]));
    console.log(`  Direct hit: #${topHit.id} "${ids[topHit.id].slice(0, 40)}" (score 1.00)`);
    if (boost.size === 0) {
      console.log('  -> no wired neighbours');
    } else {
      for (const [nid, add] of [...boost.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  -> #${nid} gets +${add.toFixed(3)} associative boost   ${ids[nid].slice(0, 38)}`);
      }
    }
  }

  // ── Report: the cold, untouched memory ─────────────────────────────────
  const cold = rows.filter((r) => r.count === 0);
  console.log(`\nNEVER-RETRIEVED (neutral 0.5, no boost, NOT deleted): ${cold.length} turn(s)`);
  for (const c of cold) console.log(`  #${c.id}  "${c.prompt.slice(0, 50)}"`);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => { console.error(err); process.exit(1); });
