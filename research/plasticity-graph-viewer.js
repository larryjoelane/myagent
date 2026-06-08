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
// self-re-execs under Electron-as-Node (the same trick bin/memory-search.js
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

// Short on-canvas label: a few words, hard-capped, single line. The FULL
// prompt/answer stays available on hover (the tooltip), so the node label only
// needs to be a recognizable handle — long wrapped labels collide when nodes
// sit close together (the "jumbled words" problem).
const NODE_LABEL_MAX = 22;
function shortLabel(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (s.length <= NODE_LABEL_MAX) return s;
  // Cut at the last word boundary within the cap so we don't slice mid-word.
  const cut = s.slice(0, NODE_LABEL_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function renderHtml(snapshot) {
  // Cytoscape elements: nodes carry energy/retrievalCount; edges carry weight.
  const elements = [
    ...snapshot.nodes.map((n) => ({
      data: {
        id: `n${n.id}`,
        label: shortLabel(n.prompt),
        prompt: n.prompt,
        answer: n.answer,
        energy: n.energy,
        retrievalCount: n.retrievalCount,
      },
    })),
    ...snapshot.edges.map((e) => ({
      data: { id: `e${e.id}`, source: `n${e.source}`, target: `n${e.target}`, weight: e.weight },
    })),
  ];
  const data = JSON.stringify({ elements, meta: snapshot.meta }, null, 2);

  // Self-contained: Cytoscape + fcose layout from CDN, everything else inline.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Memory Plasticity Graph</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace;
         background: #0b0f14; color: #cfe3f2; }
  #bar { padding: 10px 14px; border-bottom: 1px solid #1d2733; display: flex;
         gap: 18px; align-items: center; flex-wrap: wrap; }
  #bar b { color: #7fd4ff; }
  #cy { width: 100vw; height: calc(100vh - 46px); display: block; }

  /* Search box + autocomplete dropdown (setupSearch) */
  #search-wrap { position: relative; margin-left: auto; }
  #search { width: 240px; padding: 5px 9px; font: inherit; font-size: 12px;
            color: #cfe3f2; background: #11202e; border: 1px solid #2a3a4a;
            border-radius: 6px; outline: none; }
  #search:focus { border-color: #7fd4ff; }
  #search-results { position: absolute; top: 30px; left: 0; width: 100%;
            max-height: 280px; overflow-y: auto; background: #0f1a24;
            border: 1px solid #2a3a4a; border-radius: 6px; z-index: 20;
            display: none; box-shadow: 0 6px 22px #000a; }
  #search-results.open { display: block; }
  .sr-item { padding: 6px 9px; cursor: pointer; font-size: 12px;
            display: flex; gap: 8px; align-items: center; border-bottom: 1px solid #16242f; }
  .sr-item:last-child { border-bottom: none; }
  .sr-item.active, .sr-item:hover { background: #1b2e3e; }
  .sr-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
  .sr-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sr-empty { padding: 8px 9px; color: #6f8aa0; font-size: 12px; }

  /* Collapsible legend panel (setupLegend) */
  #legend { position: fixed; right: 14px; bottom: 14px; width: 300px;
            background: #0f1a24ee; border: 1px solid #2a3a4a; border-radius: 8px;
            z-index: 15; box-shadow: 0 6px 22px #0008; font-size: 12px; }
  #legend-head { display: flex; align-items: center; justify-content: space-between;
            padding: 8px 11px; cursor: pointer; user-select: none; }
  #legend-head b { color: #7fd4ff; }
  #legend-toggle { color: #6f8aa0; font-size: 11px; }
  #legend-body { padding: 0 11px 11px; border-top: 1px solid #1d2733; }
  #legend.collapsed #legend-body { display: none; }
  #legend.collapsed { width: auto; }
  .lg-row { display: flex; gap: 9px; align-items: flex-start; margin-top: 9px; }
  .lg-vis { flex: 0 0 34px; display: flex; align-items: center; justify-content: center; padding-top: 2px; }
  .lg-dot { border-radius: 50%; }
  .lg-line { height: 0; border-top-style: solid; border-top-color: #6f8aa0; width: 26px; }
  .lg-text b { color: #cfe3f2; } .lg-text span { color: #8aa3b6; }

  #tip { position: fixed; pointer-events: none; max-width: 360px; padding: 8px 10px;
         background: #11202e; border: 1px solid #2a3a4a; border-radius: 6px;
         font-size: 12px; display: none; z-index: 10; box-shadow: 0 4px 18px #0008; }
  #tip .q { color: #7fd4ff; } #tip .a { color: #9fb7c9; margin-top: 4px; }
  #tip .meta { color: #6f8aa0; margin-top: 6px; }
</style>
</head>
<body>
  <div id="bar">
    <span>Memory Plasticity Graph</span>
    <span><b id="nc"></b> memories · <b id="ec"></b> synapses</span>
    <div id="search-wrap">
      <input id="search" type="text" placeholder="Search memories…" autocomplete="off" />
      <div id="search-results"></div>
    </div>
  </div>
  <div id="cy"></div>
  <div id="legend"></div>
  <div id="tip"></div>
<script>
  const GRAPH = ${data};
  document.getElementById('nc').textContent = GRAPH.meta.nodeCount;
  document.getElementById('ec').textContent = GRAPH.meta.edgeCount;
  const eMax = GRAPH.meta.energyMax || 1;
  const wMax = GRAPH.meta.weightMax || 1;

  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements: GRAPH.elements,
    style: [
      { selector: 'node', style: {
          'label': 'data(label)',
          'color': '#cfe3f2',
          'font-size': 10,
          // Single short line, ellipsized — no multi-line wrap that collides
          // with neighbours. Full text is in the hover tooltip.
          'text-wrap': 'ellipsis',
          'text-max-width': 130,
          'text-valign': 'bottom',
          'text-margin-y': 4,
          'text-background-color': '#0b0f14',
          'text-background-opacity': 0.72,
          'text-background-padding': 2,
          'text-background-shape': 'roundrectangle',
          // Size scales with retrieval frequency (min 16, +6 per recall, capped).
          'width': 'mapData(retrievalCount, 0, 8, 18, 64)',
          'height': 'mapData(retrievalCount, 0, 8, 18, 64)',
          // Colour scales with energy: cold blue -> hot orange.
          'background-color': 'mapData(energy, 0.5, ' + eMax + ', #1f5f8b, #ff7a45)',
          'border-width': 1, 'border-color': '#0b0f14',
      } },
      { selector: 'edge', style: {
          'curve-style': 'bezier',
          'line-color': '#3a5a72',
          'opacity': 0.7,
          // Thickness scales with Hebbian weight.
          'width': 'mapData(weight, 1, ' + wMax + ', 1, 9)',
      } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#7fd4ff' } },
    ],
    // More repulsion + longer edges so nodes (and their labels) don't crowd.
    layout: { name: 'cose', animate: true, idealEdgeLength: 140, nodeRepulsion: 24000,
              componentSpacing: 140, padding: 50, randomize: true },
  });

  // Hover tooltip with the full Q + A and plasticity stats.
  const tip = document.getElementById('tip');
  cy.on('mouseover', 'node', (ev) => {
    const d = ev.target.data();
    tip.innerHTML = '<div class="q">Q: ' + esc(d.prompt) + '</div>'
      + '<div class="a">A: ' + esc(d.answer) + '</div>'
      + '<div class="meta">energy ' + d.energy.toFixed(2) + ' · recalls ' + d.retrievalCount + '</div>';
    tip.style.display = 'block';
  });
  cy.on('mousemove', 'node', (ev) => {
    const e = ev.originalEvent;
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  cy.on('mouseout', 'node', () => { tip.style.display = 'none'; });
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  // ── Autocomplete search ────────────────────────────────────────────────
  // Live-filters nodes by prompt/answer text, shows a ranked dropdown, and on
  // pick centers + selects the node (and visually dims the rest briefly).
  // Keyboard: ↑/↓ to move, Enter to pick, Esc to close.
  function setupSearch(cy) {
    const input = document.getElementById('search');
    const panel = document.getElementById('search-results');
    // Build a lightweight index once: id, label, searchable haystack, color.
    const index = cy.nodes().map((n) => {
      const d = n.data();
      return {
        id: n.id(),
        label: d.label,
        prompt: d.prompt,
        hay: (d.prompt + ' ' + d.answer).toLowerCase(),
        color: n.style('background-color'),
      };
    });
    let active = -1;   // highlighted row in the dropdown
    let matches = [];

    function close() { panel.classList.remove('open'); panel.innerHTML = ''; active = -1; }

    function focusNode(id) {
      const node = cy.getElementById(id);
      if (!node || node.empty()) return;
      cy.elements().unselect();
      node.select();
      cy.animate({ center: { eles: node }, zoom: 1.4 }, { duration: 350 });
      close();
      input.blur();
    }

    function render() {
      if (matches.length === 0) {
        panel.innerHTML = '<div class="sr-empty">no matches</div>';
        panel.classList.add('open');
        return;
      }
      panel.innerHTML = matches.map((m, i) =>
        '<div class="sr-item' + (i === active ? ' active' : '') + '" data-id="' + m.id + '">'
        + '<span class="sr-dot" style="background:' + m.color + '"></span>'
        + '<span class="sr-text">' + esc(m.prompt) + '</span></div>',
      ).join('');
      panel.classList.add('open');
      // Click a row to pick it.
      panel.querySelectorAll('.sr-item').forEach((el) => {
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); focusNode(el.dataset.id); });
      });
    }

    function query() {
      const q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      matches = index.filter((it) => it.hay.includes(q)).slice(0, 12);
      active = matches.length ? 0 : -1;
      render();
    }

    input.addEventListener('input', query);
    input.addEventListener('focus', () => { if (input.value.trim()) query(); });
    input.addEventListener('blur', () => setTimeout(close, 120)); // allow row mousedown
    input.addEventListener('keydown', (ev) => {
      if (!panel.classList.contains('open')) return;
      if (ev.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); render(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); ev.preventDefault(); }
      else if (ev.key === 'Enter') { if (matches[active]) focusNode(matches[active].id); ev.preventDefault(); }
      else if (ev.key === 'Escape') { close(); input.blur(); }
    });
  }

  // ── Collapsible legend ─────────────────────────────────────────────────
  // Builds the legend panel from a data list (so the explained values stay in
  // one place) and wires the header to collapse/expand. Persists the open
  // state in localStorage so it stays how you left it across reloads.
  function setupLegend() {
    const el = document.getElementById('legend');
    const rows = [
      { vis: '<span class="lg-dot" style="width:18px;height:18px;background:#ff7a45"></span>',
        title: 'Node colour = energy',
        desc: 'Hot orange = recalled often & recently; cold blue = stale or never recalled (neutral 0.5). Energy re-ranks search; it never deletes.' },
      { vis: '<span class="lg-dot" style="width:22px;height:22px;background:#3a546a"></span>',
        title: 'Node size = retrieval count',
        desc: 'Bigger = pulled into more searches. Saturates so a 50× memory is not 10× larger than a 5× one.' },
      { vis: '<span class="lg-line" style="border-top-width:5px"></span>',
        title: 'Edge thickness = co-retrieval weight',
        desc: 'A synapse between two memories that surfaced together. Thicker = fired together more often (Hebbian wiring).' },
      { vis: '<span class="lg-dot" style="width:14px;height:14px;background:#1f5f8b"></span>',
        title: 'Isolated cold node',
        desc: 'A memory returned in searches but below the firing threshold — shown, but never reinforced (no pollution).' },
    ];
    const collapsed = localStorage.getItem('legendCollapsed') === '1';
    el.className = collapsed ? 'collapsed' : '';
    el.innerHTML =
      '<div id="legend-head"><b>Legend</b><span id="legend-toggle">'
      + (collapsed ? '▸ show' : '▾ hide') + '</span></div>'
      + '<div id="legend-body">'
      + rows.map((r) =>
          '<div class="lg-row"><div class="lg-vis">' + r.vis + '</div>'
          + '<div class="lg-text"><b>' + r.title + '</b><br><span>' + r.desc + '</span></div></div>',
        ).join('')
      + '</div>';
    document.getElementById('legend-head').addEventListener('click', () => {
      const nowCollapsed = !el.classList.contains('collapsed');
      el.classList.toggle('collapsed', nowCollapsed);
      localStorage.setItem('legendCollapsed', nowCollapsed ? '1' : '0');
      document.getElementById('legend-toggle').textContent = nowCollapsed ? '▸ show' : '▾ hide';
    });
  }

  setupSearch(cy);
  setupLegend();
</script>
</body>
</html>`;
}

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
  fs.writeFileSync(OUT_HTML, renderHtml(snapshot), 'utf8');
  console.log(`\nGraph: ${snapshot.meta.nodeCount} nodes, ${snapshot.meta.edgeCount} edges`);
  console.log(`Wrote ${OUT_HTML}`);

  db.close();
  cleanup();

  // Best-effort: open in the default browser unless --no-open was passed.
  if (!process.argv.includes('--no-open')) {
    openInBrowser(OUT_HTML);
    console.log('Opening in your browser… (hover a node for its Q+A and energy)');
  } else {
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
