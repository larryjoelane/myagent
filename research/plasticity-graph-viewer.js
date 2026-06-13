// plasticity-graph-viewer.js — render the memory plasticity graph as a
// standalone, self-contained HTML file (Cytoscape.js from CDN).
//
// Standalone-first by design: prove the data path + visualization outside the
// app, double-clickable, before promoting it to an in-app panel. The same
// graphSnapshot() contract will feed the eventual panel — only the transport
// (file vs IPC) changes.
//
// Modes:
//   npm run graph                          -> seed a demo store, fire queries,
//        snapshot, write research/plasticity-graph.html, and OPEN it
//   npm run graph -- <path.db>             -> snapshot an EXISTING index.db
//        (read-only; no seeding, no firing) and open the HTML
//   npm run graph -- --no-open             -> write the HTML but don't open it
//   (node research/plasticity-graph-viewer.js [...] works identically)
//
// Needs better-sqlite3, whose ABI is built for Electron — so this script
// self-re-execs under Electron-as-Node (the same trick .claude/skills/recall/recall.js
// uses). That means ALL of these work identically:
//   npm run graph
//   node research/plasticity-graph-viewer.js
//   node research/plasticity-graph-viewer.js path/to/index.db
// No one-liner needed; the re-exec is automatic.

const path = require('path');

// ── Self-re-exec under Electron-as-Node (before requiring native modules) ──
const RUNNING_UNDER_ELECTRON =
  process.env.ELECTRON_RUN_AS_NODE === '1' || Boolean(process.versions.electron);
if (!RUNNING_UNDER_ELECTRON) {
  let electronBin;
  try { electronBin = require('electron'); }
  catch (err) {
    process.stderr.write(
      'plasticity-graph-viewer: cannot find Electron — run `npm install` first.\n'
      + `  underlying error: ${err.message}\n`,
    );
    process.exit(1);
  }
  const child = require('child_process').spawnSync(
    electronBin, [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MYAGENT_QUIET: '1' } },
  );
  if (child.error) {
    process.stderr.write(`plasticity-graph-viewer: failed to launch Electron — ${child.error.message}\n`);
    process.exit(1);
  }
  process.exit(child.status == null ? 1 : child.status);
}

// ── From here we ARE under Electron-as-Node; native modules are safe. ──
const fs = require('fs');
const os = require('os');
const sessionIndex = require('../src/core/sessionIndex');

const OUT_HTML = path.join(__dirname, 'plasticity-graph.html');

// Seed + fire a representative store (mirrors plasticity-demo.js) so the viewer
// has something interesting to show when run with no DB argument.
async function seedDemoDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plasticity-graph-'));
  const db = sessionIndex.open(path.join(dir, 'index.db'));
  const seed = [
    { prompt: 'how does the vulkan fallback work on intel',       answer: 'llama.cpp uses the Vulkan backend on the Intel GPU; CPU fallback otherwise.' },
    { prompt: 'which gguf model fits 8gb vram',                    answer: 'Qwen2.5-Coder-7B Q4_K_M is 4.68GB and fits with room for KV cache.' },
    { prompt: 'can we constrain the model output format',         answer: 'Yes — GBNF grammar constrains decoding so invalid tokens cannot be sampled.' },
    { prompt: 'how should we weigh decayed memories',             answer: 'Rank by energy (recency x frequency), do not delete them.' },
    { prompt: 'what is spreading activation in the memory graph',  answer: 'A hit cascades score to wired neighbours — associative recall.' },
    { prompt: 'remind me about the quarterly tax filing deadline', answer: 'Noted — unrelated to the model work.' },
  ];
  for (const s of seed) await sessionIndex.storeTurn(db, s);
  // The user keeps returning to the local-model topic; touches memory once.
  const queries = [
    'vulkan intel gpu', 'gguf model 8gb', 'vulkan fallback model',
    'grammar constrain output', 'vulkan model gguf grammar', 'spreading activation memory',
  ];
  for (const q of queries) await sessionIndex.searchTurns(db, q, { limit: 3 });
  return { db, dir };
}

const { renderHtml } = require('./viewer-template');

async function main() {
  // First non-flag arg is an optional DB path; flags (--no-open) are ignored here.
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  let db; let cleanup = () => {};
  if (arg) {
    // Snapshot an existing DB read-only — no seeding, no firing.
    db = sessionIndex.open(path.resolve(arg));
    console.log(`Snapshotting existing DB: ${arg}`);
  } else {
    const seeded = await seedDemoDb();
    db = seeded.db;
    cleanup = () => { try { fs.rmSync(seeded.dir, { recursive: true, force: true }); } catch {} };
    console.log('Seeded a demo store and fired the query script.');
  }

  const snapshot = sessionIndex.graphSnapshot(db, { limit: 200 });

  // --server emits the FETCH-mode page (no embedded data; the page calls
  // /api/graph). This is the exact HTML the Cloudflare Worker will serve — a
  // companion `graph-server.json` is written so you can preview it locally
  // with any static server that also serves that JSON at /api/graph.
  const serverMode = process.argv.includes('--server');
  if (serverMode) {
    fs.writeFileSync(OUT_HTML, renderHtml(snapshot, { embed: false }), 'utf8');
    fs.writeFileSync(path.join(__dirname, 'graph-server.json'), JSON.stringify(snapshot), 'utf8');
    console.log(`\nGraph: ${snapshot.meta.nodeCount} nodes, ${snapshot.meta.edgeCount} edges (SERVER mode)`);
    console.log(`Wrote ${OUT_HTML} (fetches /api/graph) + graph-server.json`);
  } else {
    fs.writeFileSync(OUT_HTML, renderHtml(snapshot), 'utf8');
    console.log(`\nGraph: ${snapshot.meta.nodeCount} nodes, ${snapshot.meta.edgeCount} edges`);
    console.log(`Wrote ${OUT_HTML}`);
  }

  db.close();
  cleanup();

  // Best-effort: open in the default browser unless --no-open / --server.
  if (!process.argv.includes('--no-open') && !serverMode) {
    openInBrowser(OUT_HTML);
    console.log('Opening in your browser… (hover a node for its Q+A and energy)');
  } else if (!serverMode) {
    console.log('Open it in a browser to explore (hover a node for its Q+A and energy).');
  }
}

// Open a file with the OS default handler. Detached + unref so we don't block
// or hold the process open; failures are swallowed (the path is printed above
// regardless, so the user can always open it manually).
function openInBrowser(file) {
  try {
    const cp = require('child_process');
    const cmd = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', file] : [file];
    cp.spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* user can open the printed path manually */ }
}

main().catch((err) => { console.error(err); process.exit(1); });
