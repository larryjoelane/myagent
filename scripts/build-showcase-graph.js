#!/usr/bin/env node
// build-showcase-graph.js — generate the SELF-CONTAINED Hebbian-memory graph
// for the GitHub Pages showcase (docs-site/plasticity-graph.html).
//
// Uses SYNTHETIC demo data only — never the user's real .myagent index — so
// nothing private is published. Seeds a themed set of Q+A "memories", then
// fires a realistic query stream so neurons gain energy (recency×frequency)
// and co-retrieved turns wire together (Hebbian edges). The result is a denser,
// more illustrative graph than the bare `npm run graph` demo.
//
// Re-execs under Electron-as-Node for the better-sqlite3 ABI (same trick as
// research/plasticity-graph-viewer.js).
//
// Usage:  node scripts/build-showcase-graph.js   (via `npm run showcase:graph`)

const RUNNING_UNDER_ELECTRON =
  process.env.ELECTRON_RUN_AS_NODE === '1' || Boolean(process.versions.electron);

if (!RUNNING_UNDER_ELECTRON) {
  let electronBin;
  try { electronBin = require('electron'); }
  catch (e) {
    process.stderr.write(`build-showcase-graph: Electron not found — run \`npm install\`. (${e.message})\n`);
    process.exit(1);
  }
  const cp = require('child_process');
  const child = cp.spawnSync(electronBin, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MYAGENT_QUIET: '1' },
  });
  process.exit(child.status == null ? 1 : child.status);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionIndex = require('../src/core/sessionIndex');
const { renderHtml } = require('../research/viewer-template');

const OUT_DIR = path.join(__dirname, '..', 'docs-site');
const OUT_HTML = path.join(OUT_DIR, 'plasticity-graph.html');

// Synthetic memories across a few loosely-related topics, so the graph shows
// distinct clusters that wire together through cross-topic queries.
const SEED = [
  // local models / inference
  { prompt: 'how does the vulkan fallback work on intel', answer: 'llama.cpp uses the Vulkan backend on the Intel GPU; CPU fallback otherwise.' },
  { prompt: 'which gguf model fits 8gb vram', answer: 'Qwen2.5-Coder-7B Q4_K_M is 4.68GB and fits with room for KV cache.' },
  { prompt: 'can we constrain the model output format', answer: 'Yes — a GBNF grammar constrains decoding so invalid tokens cannot be sampled.' },
  { prompt: 'what quantization should I use on a small gpu', answer: 'q4f16 on WebGPU; fall back to int8 (q8) on CPU where fp16 sessions fail.' },
  // memory / retrieval
  { prompt: 'how should we weigh decayed memories', answer: 'Rank by energy (recency × frequency); never delete — decay only re-ranks.' },
  { prompt: 'what is spreading activation in the memory graph', answer: 'A hit cascades a fraction of its score to wired neighbours — associative recall.' },
  { prompt: 'how do memories wire together', answer: 'Neurons that fire together wire together: co-retrieved turns gain a Hebbian edge.' },
  { prompt: 'what is the auto context threshold for', answer: 'It filters injected memories by match score so only relevant context is prepended.' },
  // agents / tooling
  { prompt: 'how do worker scopes bound file access', answer: 'Each worker holds a Scope allow-list; fs tools reject paths outside it (ADR-0008).' },
  { prompt: 'what gates a tool call before it runs', answer: 'preTool hooks run first; the no-secrets hook blocks writing secret-looking content.' },
  // an unrelated island that should stay cold/isolated
  { prompt: 'remind me about the quarterly tax filing deadline', answer: 'Noted — unrelated to the engineering work.' },
];

// A query stream that keeps returning to the model + memory topics so they grow
// hot and wire together. Each query is phrased to pull MULTIPLE strong hits
// from one cluster — only hits clearing the firing floor (~0.4) wire an edge,
// so broad, on-topic phrasing is what builds the synapse graph. Hot clusters
// are queried repeatedly to strengthen edge weights. The "taxes" turn is never
// queried, so it stays cold + isolated — a visible contrast in the graph.
const QUERIES = [
  // model / inference cluster (vulkan, gguf, quantization wire together)
  'vulkan gguf quantization gpu model fallback',
  'which gguf model and quantization fits a small gpu with vulkan',
  'vulkan fallback gguf vram quantization on intel gpu',
  'vulkan gguf quantization gpu model fallback',      // repeat → stronger edges
  // memory / retrieval cluster (energy, spreading, wiring together)
  'memory energy spreading activation wire neighbours decayed',
  'how do memories wire together and spread activation by energy',
  'spreading activation energy recency frequency memory neighbours',
  'memory energy spreading activation wire neighbours decayed',  // repeat
  // a cross-cluster query that lightly links model ↔ memory
  'how does the model use memory energy and gguf context',
  // tooling cluster, touched once (warm but loosely wired)
  'worker scope file access hook gates a tool call',
  'preTool hook scope blocks file access for a worker',
];

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-showcase-'));
  // open() creates + migrates the schema (MySecondBrain, vectors, msb_*).
  const db = sessionIndex.open(path.join(dir, 'index.db'));
  try {
    for (const s of SEED) await sessionIndex.storeTurn(db, s);
    // Fire the query stream — each retrieval reinforces neurons + wires edges.
    // A slightly lower firing floor than the app default (0.4) wires more of
    // the co-retrieved demo turns, so the showcase graph is denser and more
    // illustrative. This only affects the synthetic demo, not the app.
    for (const q of QUERIES) {
      await sessionIndex.searchTurns(db, q, { limit: 3, minFiringConfidence: 0.25 });
    }
    const snapshot = sessionIndex.graphSnapshot(db, { limit: 200 });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // embed:true → self-contained HTML with data inlined (no server needed).
    fs.writeFileSync(OUT_HTML, renderHtml(snapshot, { embed: true }), 'utf8');
    const nodes = (snapshot.nodes || []).length;
    const edges = (snapshot.edges || []).length;
    process.stdout.write(`Showcase graph: ${nodes} nodes, ${edges} edges\nWrote ${OUT_HTML}\n`);
  } finally {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { process.stderr.write(`build-showcase-graph failed: ${e.stack || e}\n`); process.exit(1); });
