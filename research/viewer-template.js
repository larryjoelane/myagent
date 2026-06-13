// viewer-template.js — the memory-graph viewer HTML, with NO database or
// Node-native deps. Pure: takes a graphSnapshot() object, returns an HTML string.
// Shared by the standalone generator (plasticity-graph-viewer.js) AND the
// Cloudflare Worker vendor step, so there is ONE source for the page.
//
// renderHtml(snapshot, { embed, apiPath }):
//   embed=true  -> bake data in as window.__GRAPH__ (offline standalone file)
//   embed=false -> omit data; page fetch()es apiPath (Worker / in-app panel)

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

// Render the viewer HTML. Two data-delivery modes (same markup + JS either way):
//   embed=true  → bake the snapshot into the page as window.__GRAPH__ (the
//                 standalone file works offline, no server needed).
//   embed=false → omit the data; the page fetch()es opts.apiPath at load
//                 (the Worker / in-app panel serves the graph from /api/graph).
// The snapshot→cytoscape transform + render now run CLIENT-SIDE (in boot()), so
// fetched and embedded data take the identical path.
function renderHtml(snapshot, { embed = true, apiPath = '/api/graph' } = {}) {
  const embeddedData = embed
    ? `\n  window.__GRAPH__ = ${JSON.stringify(snapshot)};`
    : '';

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
<script>${embeddedData}
  const API_PATH = ${JSON.stringify(apiPath)};

  // Short on-canvas label (full text stays in the hover tooltip).
  const NODE_LABEL_MAX = ${NODE_LABEL_MAX};
  function shortLabel(prompt) {
    const s = String(prompt || '').replace(/\\s+/g, ' ').trim();
    if (s.length <= NODE_LABEL_MAX) return s;
    const cut = s.slice(0, NODE_LABEL_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 8 ? cut.slice(0, lastSpace) : cut).replace(/\\s+$/, '') + '…';
  }

  // Transform a graphSnapshot() {nodes,edges,meta} into cytoscape elements.
  // Runs client-side so embedded and fetched snapshots take the SAME path.
  function toElements(snapshot) {
    return [
      ...snapshot.nodes.map((n) => ({ data: {
        id: 'n' + n.id, label: shortLabel(n.prompt), prompt: n.prompt,
        answer: n.answer, energy: n.energy, retrievalCount: n.retrievalCount,
      } })),
      ...snapshot.edges.map((e) => ({ data: {
        id: 'e' + e.id, source: 'n' + e.source, target: 'n' + e.target, weight: e.weight,
      } })),
    ];
  }

  // Resolve the snapshot: embedded (standalone file) wins; otherwise fetch it
  // (Worker / in-app panel). Returns the raw graphSnapshot object.
  async function loadGraph() {
    if (window.__GRAPH__) return window.__GRAPH__;
    const res = await fetch(API_PATH, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('graph fetch failed: ' + res.status + ' ' + res.statusText);
    return res.json();
  }

  // Build the cytoscape instance + wire interactions for a loaded snapshot.
  function boot(snapshot) {
    document.getElementById('nc').textContent = snapshot.meta.nodeCount;
    document.getElementById('ec').textContent = snapshot.meta.edgeCount;
    const eMax = snapshot.meta.energyMax || 1;
    const wMax = snapshot.meta.weightMax || 1;

    const cy = cytoscape({
    container: document.getElementById('cy'),
    elements: toElements(snapshot),
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

    // Wire the two UI features once the graph is on screen.
    setupSearch(cy);
    setupLegend();
    return cy;
  }

  // Shared HTML-escape (used by the tooltip + the search dropdown).
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

  // ── Orchestration: load the snapshot (embedded or fetched), then boot ──
  loadGraph()
    .then(boot)
    .catch((err) => {
      document.getElementById('cy').innerHTML =
        '<div style="padding:30px;color:#ff9a76">Failed to load graph: '
        + esc(err.message) + '</div>';
    });
</script>
</body>
</html>`;
}

module.exports = { renderHtml, shortLabel, NODE_LABEL_MAX };
