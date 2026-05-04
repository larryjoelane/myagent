// AgentManager — chat surface that drives headless workers.
//
// Workers are managed via transport.workers.{spawn, list, send, close,
// rename}. Each worker is a claude headless subprocess or a shell.
// The chat input routes to the currently-selected worker, or by
// @-mention to a specific one. Responses stream in via chat:* IPC
// events broadcast from main.js.
//
// State that's shared with new Lit components (worker list, settings,
// pendingCwd, etc.) lives in renderer/state/store.js. After mutating
// a store field this file calls store.bump() so component subscribers
// re-render. State that's purely chat-surface-internal (openBubbles,
// optimistic-user, slash popup index, pending context badges) stays
// here as module-locals — no component needs it today.

import { store } from './state/store.js';

// Chat-surface-private state. Lives outside the store because no
// other component reads it.
//
//   openBubbles            agentId → { el, bodyEl, typingEl, hasContent, lastTextNode }
//   pendingUserOptimistic  optimistic { agentId, text } pre-chat:user
//   slashSelected          highlighted index in the slash popup
//   pendingContextBadges   agentId → context-used msg, awaiting its user bubble
const openBubbles = new Map();
let pendingUserOptimistic = null;
let slashSelected = 0;
const pendingContextBadges = new Map();

function init() {
  const transport = window.transport;
  if (!transport || !transport.workers || !transport.chat) return;

  const $ = (id) => document.getElementById(id);

  // Shared state lives in the store. Pull the live object so existing
  // reads (state.workers, state.settings.toolDetails, ...) keep working;
  // writes mirror through to the store, and we call store.bump() after
  // each one so components subscribing to the store re-render.
  const state = store.get();

  function rootEl() { return $('agent-manager'); }
  function chatEl() { return $('am-chat'); }
  function workersEl() { return $('am-workers'); }
  function emptyEl() { return $('am-empty-state'); }
  function composeEl() { return /** @type {any} */ ($('am-compose')); }
  function inputEl() { return composeEl(); }
  function settingsEl() { return $('am-settings'); }

  function show(open) {
    rootEl().classList.toggle('agent-manager--hidden', !open);
    if (open) {
      refreshAll();
      setTimeout(() => inputEl()?.focus(), 200);
    }
  }

  function toggleSettings(open) {
    const el = settingsEl();
    if (!el) return;
    state.settings.settingsOpen = (open == null) ? !state.settings.settingsOpen : !!open;
    // <settings-drawer> reflects an [open] boolean attribute. Also keep
    // the legacy class for back-compat with tests that look for it.
    /** @type {any} */ (el).open = state.settings.settingsOpen;
    el.classList.toggle('agent-manager__settings--hidden', !state.settings.settingsOpen);
  }

  // --- Worker list refresh -----------------------------------------------

  async function refreshAll() {
    try {
      const r = await transport.workers.list();
      state.workers = (r.workers || []).map((w) => ({
        id: w.id, name: w.name, kind: w.kind, cwd: w.cwd, memoryMirror: w.memoryMirror,
      }));
      renderWorkers();
      renderEmptyState();
      renderEmptyCwd();
      // <settings-drawer> subscribes to the store and re-renders the
      // workers list itself when state.workers changes.
    } catch { /* ignore transient errors */ }
  }

  function shortenPath(p) {
    if (!p) return '(default)';
    // Show last two path segments for compactness, e.g. ".../source/MyAgent".
    const parts = p.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return p;
    return '…/' + parts.slice(-2).join('/');
  }

  // Hydrate state.pendingCwd from the persisted lastCwd, then update the
  // settings-drawer cwd label. The empty-state component renders its own
  // cwd label from the store — no DOM update needed there. We call
  // store.bump() after the hydration so the component re-renders.
  async function renderEmptyCwd() {
    if (!state.pendingCwd) {
      try {
        const r = await transport.settings.get('lastCwd');
        if (r.value) {
          state.pendingCwd = r.value;
          store.bump();
        }
      } catch { /* ignore */ }
    }
    const label = state.pendingCwd ? shortenPath(state.pendingCwd) : '(repo root)';
    const tooltip = state.pendingCwd || '(repo root)';
    // Settings-drawer picker (still legacy DOM). The empty-state side
    // is owned by <empty-state>, which reads pendingCwd from the store.
    const t = $('am-spawn-cwd-text');
    if (t) t.textContent = label;
    const b = $('am-spawn-cwd');
    if (b) b.title = tooltip;
  }

  async function pickCwd() {
    try {
      const r = await transport.dialog.chooseDirectory({ defaultPath: state.pendingCwd });
      if (r.canceled || !r.path) return;
      state.pendingCwd = r.path;
      store.bump();
      await renderEmptyCwd();
    } catch { /* ignore */ }
  }

  // Embedder status, generation-model registry, and device-status
  // rendering all moved into <settings-drawer> (renderer/components/
  // settings-drawer.js). The component subscribes to the store and
  // calls actions.loadEmbedderStatus / loadGenerationModels itself.

  function workerById(id) { return state.workers.find((w) => w.id === id) || null; }

  // --- Renderers ---------------------------------------------------------

  function renderEmptyState() {
    const empty = emptyEl();
    const chat = chatEl();
    const hasWorkers = state.workers.length > 0;
    // Show the empty state ONLY when no workers AND no chat content.
    // Built-in commands like @memory render bubbles into chat even
    // without workers, so once any bubble lands the empty state
    // gets out of the way and the chat takes over.
    const hasChatContent = chat.querySelector('.bubble') != null;
    const showEmpty = !hasWorkers && !hasChatContent;
    // <empty-state> has a reflecting `hidden` boolean property (its
    // styles include :host([hidden]) { display: none; }). Also keep
    // the legacy class for back-compat with tests that look for it.
    if (empty) {
      /** @type {any} */ (empty).hidden = !showEmpty;
      empty.classList.toggle('agent-manager__empty--hidden', !showEmpty);
    }
    chat.classList.toggle('agent-manager__chat--hidden', showEmpty);
  }

  // <worker-chips> renders the strip from the store. Calling
  // renderWorkers() is now just "tell subscribers state changed" —
  // the component handles the DOM. The function name stays for the
  // existing call sites; once they're all componentized this becomes
  // dead and goes away.
  function renderWorkers() {
    store.bump();
  }

  // <worker-chips> updates state.currentTarget through the store on
  // click; we only need to focus the compose input afterwards. The
  // event listener for that is wired in init() — see workersEl()
  // 'select' handler.

  // --- Spawn flow --------------------------------------------------------

  async function spawnWorker(kind) {
    // Semantic workers get the chosen compute device + explain
    // configuration; other kinds ignore those.
    const isSem = kind === 'semantic';
    const device = isSem ? (state.pendingDevice || undefined) : undefined;
    const generationModelId = isSem && state.pendingGenerationModelId
      ? state.pendingGenerationModelId : undefined;
    // Reuse the chosen device for generation too — model.defaultDevice
    // can override later when we expose a separate picker.
    const generationDevice = isSem && generationModelId ? device : undefined;
    const defaultExplain = isSem && generationModelId ? !!state.pendingDefaultExplain : false;
    const r = await transport.workers.spawn({
      kind,
      cwd: state.pendingCwd || undefined,
      device,
      generationModelId,
      generationDevice,
      defaultExplain,
    });
    if (!r.ok) { pushBubble('system', `spawn failed: ${r.error || 'unknown'}`); return; }
    state.currentTarget = r.id;
    // Visible spawn confirmation — surfaces explain config so the
    // user can immediately see whether --explain will do anything.
    // Without this, an unconfigured Semantic worker silently ignores
    // --explain (intentional, but confusing the first time).
    if (isSem) {
      const dev = device || 'cpu';
      const explainBits = generationModelId
        ? `explain: ${generationModelId} (default ${defaultExplain ? 'on' : 'off'})`
        : 'explain: disabled (no generation model picked)';
      pushBubble('system', `Spawned "${r.name}" — embed device: ${dev}, ${explainBits}`);
    }
    // Cache the worker's toolkit for slash autocomplete. Only semantic
    // workers expose tools; for other kinds the call returns ok:false
    // and we just skip (popup will not appear).
    try {
      const tr = await transport.workers.listTools(r.id);
      if (tr && tr.ok && Array.isArray(tr.tools)) {
        state.toolsByWorker.set(r.id, tr.tools);
      }
    } catch { /* ignore — autocomplete just won't show */ }
    await refreshAll();
  }

  // --- Bubbles -----------------------------------------------------------

  function pushBubble(kind, text, agentId) {
    const wrap = document.createElement('div');
    wrap.className = `bubble bubble--${kind}`;
    if (agentId) wrap.dataset.agentId = agentId;

    if (kind === 'user' || kind === 'system') {
      wrap.textContent = text || '';
    } else {
      const meta = document.createElement('div');
      meta.className = 'bubble__meta';
      const w = workerById(agentId);
      meta.textContent = w ? `@${w.name}` : (agentId || 'assistant');
      wrap.appendChild(meta);
      const body = document.createElement('pre');
      body.className = 'bubble__body';
      const typing = document.createElement('div');
      typing.className = 'typing-indicator';
      typing.innerHTML = '<span></span><span></span><span></span>';
      body.appendChild(typing);
      wrap.appendChild(body);
      wrap._bodyEl = body;
      wrap._typingEl = typing;
      if (text) {
        body.textContent = text;
        wrap._typingEl = null;
      }
    }
    chatEl().appendChild(wrap);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
    return wrap;
  }

  // Auto-context badge: rendered under the user bubble that prompted
  // a memory-injected send. Click expands to show which memories
  // were used. Lets the user verify what context Claude saw without
  // it taking visual space by default.
  function attachContextBadge(msg) {
    const hits = (msg && msg.usedHits) || [];
    if (hits.length === 0) return;
    // Find the most recent user bubble for this agent that doesn't
    // already have a badge attached. Auto-context fires before
    // chat:user, OR before the optimistic user bubble lands —
    // realistically we anchor to whichever bubble already exists,
    // and otherwise stash the badge until the user bubble appears.
    const agentId = msg.agentId;
    const userText = msg.userText || '';
    const userBubbles = chatEl().querySelectorAll('.bubble--user');
    let target = null;
    for (let i = userBubbles.length - 1; i >= 0; i--) {
      const b = userBubbles[i];
      if (b.dataset.agentId === agentId && b.textContent === userText && !b._contextBadge) {
        target = b;
        break;
      }
    }
    if (!target) {
      // Bubble hasn't been pushed yet — stash and try again on next
      // chat:user. Cheap: keep at most one pending badge per agent.
      pendingContextBadges.set(agentId, msg);
      return;
    }
    renderContextBadge(target, hits);
  }

  function renderContextBadge(userBubble, hits) {
    const badge = document.createElement('div');
    badge.className = 'context-badge';
    const summary = document.createElement('div');
    summary.className = 'context-badge__summary';
    summary.textContent = `+ used ${hits.length} ${hits.length === 1 ? 'memory' : 'memories'} as context · click to view`;
    badge.appendChild(summary);
    const detail = document.createElement('div');
    detail.className = 'context-badge__detail context-badge__detail--hidden';
    for (const h of hits) {
      const item = document.createElement('div');
      item.className = 'context-badge__hit';
      const meta = document.createElement('div');
      meta.className = 'context-badge__meta';
      const conf = (typeof h.confidence === 'number') ? h.confidence.toFixed(2) : '?';
      meta.textContent = `conf ${conf}`;
      item.appendChild(meta);
      const body = document.createElement('div');
      body.className = 'context-badge__snippet';
      body.textContent = (h.snippet || h.text || '').slice(0, 300);
      item.appendChild(body);
      detail.appendChild(item);
    }
    badge.appendChild(detail);
    summary.addEventListener('click', () => {
      detail.classList.toggle('context-badge__detail--hidden');
    });
    // Insert badge directly after the user bubble (sibling, not child).
    userBubble.insertAdjacentElement('afterend', badge);
    userBubble._contextBadge = badge;
  }

  // --- @memory built-in --------------------------------------------------

  // Default min-confidence applied when the user didn't specify
  // --min or --all. Filters obvious noise without being aggressive.
  //
  // Cosine similarity in MiniLM-L6 frequently lands at 0.3–0.4 for
  // random sentence pairs (noise floor), so 0.5 is the right cutoff
  // for "this is plausibly related." Users can drop lower with
  // --min 0.3 or see everything with --all.
  // See docs/memory-search.md "What 'confidence' means in practice."
  const DEFAULT_MIN_CONFIDENCE = 0.5;

  // Parse the flags + query out of a "@memory ..." input.
  //
  //   @memory query                       → { limit: 10, minConfidence: 0.3 }
  //   @memory --all query                 → { limit: 10, minConfidence: 0, showAll: true }
  //   @memory --limit 20 query            → { limit: 20, minConfidence: 0.3 }
  //   @memory --min 0.5 query             → { limit: undefined, minConfidence: 0.5 }
  //   @memory --limit 20 --min 0.5 query  → { limit: 20, minConfidence: 0.5 }
  //
  // When --min is set without --limit, we leave limit undefined so
  // the search returns ALL qualifying rows.
  function parseMemoryArgs(raw) {
    const tokens = String(raw).trim().split(/\s+/);
    let limit;
    let explicitMin;       // user-supplied --min value (sticks even if 0)
    let showAll = false;
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '--limit' || t === '-n') {
        const v = parseInt(tokens[i + 1], 10);
        if (Number.isFinite(v) && v > 0) limit = v;
        i += 2;
      } else if (t === '--min' || t === '--min-confidence') {
        const v = parseFloat(tokens[i + 1]);
        if (Number.isFinite(v) && v >= 0 && v <= 1) explicitMin = v;
        i += 2;
      } else if (t === '--all') {
        showAll = true;
        i += 1;
      } else {
        break; // first non-flag token = start of the query
      }
    }
    const query = tokens.slice(i).join(' ').trim();

    // Resolve the effective minConfidence:
    //   --all          → 0 (no filtering)
    //   --min X        → X (whatever the user said, even 0)
    //   neither        → DEFAULT_MIN_CONFIDENCE (smart default)
    let minConfidence;
    if (showAll) minConfidence = 0;
    else if (typeof explicitMin === 'number') minConfidence = explicitMin;
    else minConfidence = DEFAULT_MIN_CONFIDENCE;

    // Default limit: if user didn't say --limit AND didn't ask for a
    // threshold-only query (--min/--all), use 10.
    if (limit === undefined && explicitMin === undefined && !showAll) {
      limit = 10;
    }

    return { limit, minConfidence, showAll, query };
  }

  async function runMemorySearch(query, opts = {}) {
    const flagsLabel = [];
    if (opts.showAll) flagsLabel.push('--all');
    if (typeof opts.limit === 'number') flagsLabel.push(`--limit ${opts.limit}`);
    if (opts.minConfidence > 0 && !opts.showAll) flagsLabel.push(`--min ${opts.minConfidence}`);
    const echoQuery = (flagsLabel.length ? flagsLabel.join(' ') + ' ' : '') + query;
    pushUserBubble(`@memory ${echoQuery}`);
    const wrap = pushMemoryBubble({ query, hits: null });
    let result;
    try {
      const searchOpts = {};
      if (typeof opts.limit === 'number') searchOpts.limit = opts.limit;
      if (typeof opts.minConfidence === 'number' && opts.minConfidence > 0) {
        searchOpts.minConfidence = opts.minConfidence;
      }
      result = await transport.memory.search(query, searchOpts);
    } catch (err) {
      updateMemoryBubble(wrap, { query, error: err.message });
      return;
    }
    const hits = (result && result.hits) || [];
    const totalCandidates = (result && typeof result.totalCandidates === 'number')
      ? result.totalCandidates
      : hits.length;
    updateMemoryBubble(wrap, {
      query, hits,
      totalCandidates,
      minConfidence: opts.minConfidence || 0,
      showAll: !!opts.showAll,
    });
  }

  // Help bubble: shows command syntax. Triggered by `@memory`,
  // `@memory --help`, `@memory help`. Doesn't go through the
  // search path — pure documentation.
  function pushMemoryHelpBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'bubble bubble--memory bubble--memory-help';
    const header = document.createElement('div');
    header.className = 'bubble--memory__header';
    header.textContent = '@memory — search remembered chats';
    wrap.appendChild(header);
    const body = document.createElement('pre');
    body.className = 'bubble--memory-help__body';
    body.textContent = [
      'Usage:',
      `  @memory <query>             top matches with confidence ≥ ${DEFAULT_MIN_CONFIDENCE} (default)`,
      '  @memory --all <query>       include weaker matches (no threshold)',
      '  @memory --limit 20 <query>  custom result count',
      '  @memory --min 0.7 <query>   custom confidence threshold (0–1)',
      '',
      'Click any result to insert its full text into the message box.',
      'Confidence: 0.7+ strong · 0.4–0.7 plausible · 0.2–0.4 weak.',
    ].join('\n');
    wrap.appendChild(body);
    chatEl().appendChild(wrap);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
    return wrap;
  }

  function pushUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble bubble--user';
    wrap.textContent = text;
    chatEl().appendChild(wrap);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
  }

  function pushMemoryBubble({ query }) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble bubble--memory';
    const header = document.createElement('div');
    header.className = 'bubble--memory__header';
    header.textContent = `searching memory for "${query}"…`;
    wrap.appendChild(header);
    const body = document.createElement('div');
    body.className = 'bubble--memory__body';
    wrap.appendChild(body);
    wrap._headerEl = header;
    wrap._bodyEl = body;
    chatEl().appendChild(wrap);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
    return wrap;
  }

  function updateMemoryBubble(wrap, { query, hits, error, totalCandidates, minConfidence, showAll }) {
    const header = wrap._headerEl;
    const body = wrap._bodyEl;
    body.innerHTML = '';
    if (error) {
      header.textContent = `memory search failed for "${query}"`;
      const e = document.createElement('div');
      e.className = 'bubble--memory__error';
      e.textContent = error;
      body.appendChild(e);
      return;
    }
    const total = typeof totalCandidates === 'number' ? totalCandidates : (hits ? hits.length : 0);
    const shown = hits ? hits.length : 0;
    const filtered = total - shown;
    const filtering = !showAll && minConfidence > 0;

    if (shown === 0) {
      // Two flavors of "no results": truly nothing in the index, vs.
      // some weaker candidates exist below the threshold.
      if (filtering && filtered > 0) {
        header.textContent = `no strong matches for "${query}" — ${filtered} weaker hidden (try @memory --all ${query})`;
      } else {
        header.textContent = `no matches for "${query}"`;
      }
      return;
    }

    // Have at least one hit. Compose copy depends on whether we
    // filtered anything.
    const matchWord = shown === 1 ? 'match' : 'matches';
    if (filtering && filtered > 0) {
      header.textContent = `${shown} strong ${matchWord} for "${query}" · ${filtered} weaker hidden (try @memory --all ${query})`;
    } else {
      header.textContent = `${shown} ${matchWord} for "${query}" — click to insert`;
    }
    hits.forEach((hit, i) => {
      const item = document.createElement('div');
      item.className = 'bubble--memory__hit';
      item.title = 'Click to append this snippet to the compose box';

      const meta = document.createElement('div');
      meta.className = 'bubble--memory__meta';
      const sourceLabel = sourceShortName(hit.file);
      // Show user-facing confidence (0–1, max of normalized cosine
      // and per-query BM25). Falls back to RRF score for hits that
      // predate the confidence field. See docs/memory-search.md.
      const conf = (typeof hit.confidence === 'number')
        ? hit.confidence.toFixed(2)
        : (typeof hit.score === 'number' ? hit.score.toFixed(3) : '?');
      const ts = (hit.ts || '').slice(0, 19).replace('T', ' ');
      meta.textContent = `${i + 1}. ${sourceLabel} · ${ts} · conf ${conf}`;
      meta.title =
        'Confidence (0–1): max of cosine similarity and per-query BM25 ' +
        'normalized score. See docs/memory-search.md.';
      item.appendChild(meta);

      const snippet = document.createElement('div');
      snippet.className = 'bubble--memory__snippet';
      snippet.textContent = hit.snippet || '';
      item.appendChild(snippet);

      // Click → append the FULL memory to compose. We use hit.text
      // (entire row content) rather than hit.snippet (which is
      // truncated to 400 chars for compact display). Users want to
      // ground their next prompt in the complete memory, not a
      // chopped preview.
      item.addEventListener('click', () => insertSnippet(hit.text || hit.snippet || ''));

      body.appendChild(item);
    });
  }

  // Make the source path readable. Memory rows have file like
  // "<memory:chat-user:abcdef>" — we surface "chat-user".
  function sourceShortName(file) {
    if (!file) return '';
    const m = String(file).match(/<memory:([^:>]+)/);
    if (m) return m[1];
    return file;
  }

  function insertSnippet(text) {
    if (!text) return;
    composeEl()?.appendValue(text);
  }

  function appendToOpenBubble(agentId, text) {
    let entry = openBubbles.get(agentId);
    if (!entry) {
      const el = pushBubble('assistant', '', agentId);
      entry = { el, bodyEl: el._bodyEl, typingEl: el._typingEl, hasContent: false };
      openBubbles.set(agentId, entry);
    }
    if (!entry.hasContent) {
      if (entry.typingEl && entry.typingEl.parentNode) {
        entry.typingEl.parentNode.removeChild(entry.typingEl);
      }
      entry.bodyEl.textContent = '';
      entry.hasContent = true;
      entry.lastTextNode = null;
    }
    if (!text) return;
    // Append text as a text node alongside any sibling child elements
    // (e.g., tool cards). textContent += would serialize children into
    // a string and destroy the card DOM — that's the bug we hit.
    //
    // We track the "current" text node so successive text chunks
    // extend it in place (more efficient than spawning a node per
    // chunk, and groups chunks into a single span for selection).
    if (entry.lastTextNode && entry.lastTextNode.parentNode === entry.bodyEl
        && entry.bodyEl.lastChild === entry.lastTextNode) {
      entry.lastTextNode.data += text;
    } else {
      const node = document.createTextNode(text);
      entry.bodyEl.appendChild(node);
      entry.lastTextNode = node;
    }
    chatEl().scrollTop = chatEl().scrollHeight;
  }

  // Tool calls render as discrete cards inside the open assistant
  // bubble: header (tool name + status), formatted input, collapsed
  // result section. Each card is keyed by tool_use_id so the
  // matching tool_result can find its sibling card.
  function ensureOpenAssistantBubble(agentId) {
    let entry = openBubbles.get(agentId);
    if (!entry) {
      const el = pushBubble('assistant', '', agentId);
      entry = { el, bodyEl: el._bodyEl, typingEl: el._typingEl, hasContent: false };
      openBubbles.set(agentId, entry);
    }
    // Tool cards are real content — clear typing dots if still showing.
    if (!entry.hasContent) {
      if (entry.typingEl && entry.typingEl.parentNode) {
        entry.typingEl.parentNode.removeChild(entry.typingEl);
      }
      entry.bodyEl.textContent = '';
      entry.hasContent = true;
    }
    return entry;
  }

  function renderToolUseCard(msg) {
    const entry = ensureOpenAssistantBubble(msg.agentId);
    const card = document.createElement('div');
    // Default visibility comes from the toolDetails preference:
    //   'expanded'  → body visible
    //   'collapsed' → body hidden, click header to expand (DEFAULT)
    //   'hidden'    → tiny badge only, no body, no expand affordance
    const mode = state.settings.toolDetails || 'collapsed';
    card.className = 'tool-card tool-card--running';
    if (mode === 'collapsed') card.classList.add('tool-card--collapsed');
    if (mode === 'hidden') card.classList.add('tool-card--hidden-mode');
    card.dataset.toolUseId = msg.toolUseId || '';

    const header = document.createElement('div');
    header.className = 'tool-card__header';
    const icon = document.createElement('span');
    icon.className = 'tool-card__icon';
    icon.textContent = '●';
    header.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'tool-card__name';
    name.textContent = msg.name || 'tool';
    header.appendChild(name);
    const status = document.createElement('span');
    status.className = 'tool-card__status';
    status.textContent = '…running';
    header.appendChild(status);
    card.appendChild(header);

    // Input section — formatted, always visible.
    const input = document.createElement('pre');
    input.className = 'tool-card__input';
    input.textContent = formatToolInput(msg.input);
    card.appendChild(input);

    // Result placeholder. Filled when matching tool-result arrives.
    const result = document.createElement('pre');
    result.className = 'tool-card__result tool-card__result--pending';
    result.textContent = 'waiting for result…';
    card.appendChild(result);

    // Click header to expand/collapse the result.
    header.addEventListener('click', () => {
      card.classList.toggle('tool-card--collapsed');
    });

    entry.bodyEl.appendChild(card);
    // Invalidate the streaming-text-node anchor so any text chunk
    // that comes AFTER this card starts a fresh text node below it
    // rather than appending to the pre-card text node.
    entry.lastTextNode = null;
    chatEl().scrollTop = chatEl().scrollHeight;
  }

  // Semantic agent results (and help / no-match) render as a structured
  // card inside the assistant bubble: header with the tool name + Copy,
  // then the body. Long bodies (>12 lines) start collapsed at ~6 lines
  // with a "Show more" toggle. Each turn gets its own card; the bubble
  // closes at chat:turn-end so the next semantic chunk lands in a fresh
  // bubble (avoids the "results pile into the last bubble" bug).
  const SEMANTIC_COLLAPSE_LINES = 6;
  const SEMANTIC_COLLAPSE_THRESHOLD = 12;

  function renderSemanticResult(msg) {
    // semantic-explain is a streaming append to the most recent
    // tool-result card for this agent. Each token triggers one
    // chunk; we look for an existing explain region and append, or
    // create one inside the most recent semantic-card.
    if (msg.kind === 'semantic-explain') {
      appendToExplain(msg);
      return;
    }
    if (msg.kind === 'semantic-explain-error') {
      appendToExplain({ ...msg, isError: true });
      return;
    }
    const entry = ensureOpenAssistantBubble(msg.agentId);
    const raw = String(msg.text || '');
    // Strip the `[Tool Name]\n` annotation the driver prepends, if any —
    // we render the tool name in the card header instead. This keeps
    // the body pristine for copying.
    const headerMatch = raw.match(/^\[([^\]\n]+)\]\n/);
    const headerName = headerMatch ? headerMatch[1] : labelForKind(msg.kind);
    const body = headerMatch ? raw.slice(headerMatch[0].length) : raw;

    const card = document.createElement('div');
    card.className = 'semantic-card';
    card.dataset.kind = msg.kind || '';
    if (msg.toolId) card.dataset.toolId = msg.toolId;

    const header = document.createElement('div');
    header.className = 'semantic-card__header';
    const name = document.createElement('span');
    name.className = 'semantic-card__name';
    name.textContent = headerName;
    header.appendChild(name);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'semantic-card__copy';
    copyBtn.type = 'button';
    copyBtn.title = 'Copy result text';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyTextToClipboard(body, copyBtn);
    });
    header.appendChild(copyBtn);
    card.appendChild(header);

    const bodyEl = document.createElement('pre');
    bodyEl.className = 'semantic-card__body';
    bodyEl.textContent = body;
    card.appendChild(bodyEl);

    // Auto-collapse long bodies. Toggle is wired on the header (clicking
    // the name region — the Copy button stops propagation above).
    const lineCount = body.split('\n').length;
    if (lineCount > SEMANTIC_COLLAPSE_THRESHOLD) {
      card.classList.add('semantic-card--collapsible');
      card.classList.add('semantic-card--collapsed');
      bodyEl.style.setProperty('--semantic-collapse-lines', String(SEMANTIC_COLLAPSE_LINES));
      const toggle = document.createElement('button');
      toggle.className = 'semantic-card__toggle';
      toggle.type = 'button';
      toggle.textContent = `Show all ${lineCount} lines`;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowExpanded = card.classList.toggle('semantic-card--collapsed') === false;
        toggle.textContent = nowExpanded
          ? 'Collapse'
          : `Show all ${lineCount} lines`;
      });
      card.appendChild(toggle);
      // Also let the user toggle by clicking the header name region.
      header.addEventListener('click', (e) => {
        if (e.target === copyBtn) return;
        const nowExpanded = card.classList.toggle('semantic-card--collapsed') === false;
        toggle.textContent = nowExpanded
          ? 'Collapse'
          : `Show all ${lineCount} lines`;
      });
    }

    entry.bodyEl.appendChild(card);
    entry.lastTextNode = null;
    chatEl().scrollTop = chatEl().scrollHeight;
  }

  // Stream an explanation token into the latest semantic-card for
   // this agent. Creates the explain region on the first token; later
   // tokens append (uses cumulativeText when present so missing
   // tokens don't drift).
  function appendToExplain(msg) {
    const bubble = openBubbles.get(msg.agentId);
    if (!bubble) return;
    const cards = bubble.bodyEl.querySelectorAll('.semantic-card');
    const card = cards[cards.length - 1];
    if (!card) return;
    let region = card.querySelector('.semantic-card__explain');
    if (!region) {
      region = document.createElement('div');
      region.className = 'semantic-card__explain';
      const label = document.createElement('div');
      label.className = 'semantic-card__explain-label';
      label.textContent = msg.isError ? 'Explain (failed)' : 'Explain';
      region.appendChild(label);
      const body = document.createElement('div');
      body.className = 'semantic-card__explain-body';
      region.appendChild(body);
      card.appendChild(region);
    }
    const body = region.querySelector('.semantic-card__explain-body');
    if (msg.isError) {
      region.classList.add('semantic-card__explain--error');
      body.textContent = msg.text || '(unknown error)';
    } else if (msg.cumulativeText) {
      // Cumulative text is authoritative — preserves correctness if
      // a token chunk was missed.
      body.textContent = msg.cumulativeText;
    } else if (msg.text) {
      body.textContent += msg.text;
    }
    chatEl().scrollTop = chatEl().scrollHeight;
  }

  function labelForKind(kind) {
    if (kind === 'semantic-help') return 'Help';
    if (kind === 'semantic-no-match') return 'No match';
    if (kind === 'semantic-slash') return 'Slash';
    return 'Result';
  }

  // Copy with a quick visual confirmation. Falls back to execCommand
  // when the Clipboard API isn't available (older Electron, file://).
  async function copyTextToClipboard(text, button) {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* fall through */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (button) {
      const original = button.textContent;
      button.textContent = ok ? 'Copied' : 'Failed';
      button.classList.add(ok ? 'semantic-card__copy--ok' : 'semantic-card__copy--err');
      setTimeout(() => {
        button.textContent = original;
        button.classList.remove('semantic-card__copy--ok', 'semantic-card__copy--err');
      }, 1200);
    }
  }

  function renderToolResult(msg) {
    // Find the card with matching tool_use_id. If the chat is mid-render
    // and the use card hasn't appeared yet, append a standalone result.
    const id = msg.toolUseId || '';
    const card = document.querySelector(`.tool-card[data-tool-use-id="${cssEscape(id)}"]`);
    if (!card) {
      // Fall back to inline text — shouldn't happen in normal flow.
      appendToOpenBubble(msg.agentId, `[tool-result orphan] ${formatToolResultBody(msg.content)}\n`);
      return;
    }
    card.classList.remove('tool-card--running');
    card.classList.add(msg.isError ? 'tool-card--error' : 'tool-card--ok');
    const status = card.querySelector('.tool-card__status');
    if (status) status.textContent = msg.isError ? '✗ error' : '✓ done';
    const result = card.querySelector('.tool-card__result');
    if (result) {
      result.classList.remove('tool-card__result--pending');
      result.textContent = formatToolResultBody(msg.content);
    }
  }

  function formatToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input, null, 2); }
    catch { return String(input); }
  }

  function formatToolResultBody(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    // Anthropic's content can be an array of {type, text} blocks.
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === 'object' && 'text' in c) ? c.text : JSON.stringify(c))
        .join('\n');
    }
    try { return JSON.stringify(content, null, 2); }
    catch { return String(content); }
  }

  // CSS.escape isn't on every CSS spec; tool_use_ids are alphanumeric
  // + underscores so a small fallback is plenty.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function closeOpenBubble(agentId) {
    const entry = openBubbles.get(agentId);
    if (!entry) return;
    entry.el.classList.add('bubble--done');
    if (!entry.hasContent && entry.typingEl) {
      entry.typingEl.parentNode.removeChild(entry.typingEl);
      entry.bodyEl.textContent = '(no response)';
      entry.bodyEl.style.color = 'var(--text-faint)';
    }
    openBubbles.delete(agentId);
  }

  // --- Sending -----------------------------------------------------------

  // Parse a mention from raw input. Worker names may contain spaces
  // (default "Worker 1", "Worker 2"), so we can't use a simple
  // \S+ token boundary. Strategy: take everything after the @,
  // then greedily try the longest-prefix that matches a known
  // worker name (case-insensitive). The remainder is the prompt.
  function parseMention(raw) {
    const lead = raw.match(/^\s*@([\s\S]*)$/);
    if (!lead) return { mention: null, text: raw.trim() };
    const tail = lead[1];
    // Walk word boundaries from longest to shortest. Tokens like
    // "Worker 2 the rest" produce candidates: "Worker 2 the rest",
    // "Worker 2 the", "Worker 2", "Worker".
    // We try each as a name; first match wins.
    const tokens = tail.split(/(\s+)/);
    // Build candidate prefixes with their break points.
    let acc = '';
    const candidates = [];
    for (let i = 0; i < tokens.length; i++) {
      acc += tokens[i];
      if (acc.trim().length === 0) continue;
      candidates.push({ mention: acc.trim(), restStart: acc.length });
    }
    // Try longest first. If the longest prefix matches, the rest
    // (after restStart) is the prompt.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      const target = resolveTargetByName(c.mention);
      if (target) {
        return { mention: c.mention, text: tail.slice(c.restStart).trim() };
      }
    }
    // No prefix matched — fall back to the first whitespace-bounded
    // token so resolveTarget can produce a "no such worker" error.
    const firstToken = tail.match(/^\s*(\S+)\s+([\s\S]*)$/);
    if (firstToken) return { mention: firstToken[1], text: firstToken[2].trim() };
    return { mention: tail.trim(), text: '' };
  }

  function resolveTargetByName(name) {
    const exact = state.workers.find((w) => w.name === name);
    if (exact) return exact;
    const ci = state.workers.find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (ci) return ci;
    const prefix = state.workers.find((w) => w.name.toLowerCase().startsWith(name.toLowerCase()));
    if (prefix) return prefix;
    return null;
  }

  function resolveTarget(mention) {
    if (mention) {
      const t = resolveTargetByName(mention);
      if (t) return t;
      return null;
    }
    if (state.currentTarget) return workerById(state.currentTarget);
    if (state.workers.length === 1) return state.workers[0];
    return null;
  }

  async function send(rawArg) {
    const compose = composeEl();
    const raw = (typeof rawArg === 'string') ? rawArg : (compose?.value || '');
    if (!raw.trim()) return;

    // Built-in @memory command — searches the memory index and
    // renders results inline. Reserved name; never resolves to a
    // worker even if one is somehow named "memory".
    //
    // Forms:
    //   @memory                           → help bubble
    //   @memory --help | help             → help bubble
    //   @memory <query>                   → top results, default min-confidence
    //   @memory --all <query>             → no min-confidence (escape hatch)
    //   @memory --limit N <query>         → custom result count
    //   @memory --min X <query>           → custom threshold
    //   (flags compose; flags before query)
    const memoryRe = /^\s*@memory(?:\s+([\s\S]+))?$/i;
    const memoryMatch = raw.match(memoryRe);
    if (memoryMatch) {
      const tail = (memoryMatch[1] || '').trim();
      compose?.clear();
      if (!tail || tail === '--help' || tail === '-h' || tail === 'help') {
        pushMemoryHelpBubble();
        return;
      }
      const parsed = parseMemoryArgs(tail);
      if (!parsed.query) {
        pushMemoryHelpBubble();
        return;
      }
      await runMemorySearch(parsed.query, {
        limit: parsed.limit,
        minConfidence: parsed.minConfidence,
        showAll: parsed.showAll,
      });
      return;
    }

    const { mention, text } = parseMention(raw);
    const target = resolveTarget(mention);
    if (!target) {
      pushBubble('system', mention
        ? `No worker named @${mention}. Available: ${state.workers.map((w) => '@' + w.name).join(', ') || '(none)'}`
        : 'Pick a worker with @name first.');
      return;
    }
    if (!text) { pushBubble('system', 'Empty message.'); return; }

    state.currentTarget = target.id;
    state.thinkingWorkers.add(target.id);
    renderWorkers();

    pendingUserOptimistic = { agentId: target.id, text };
    pushBubble('user', text, target.id);
    compose?.clear();

    const placeholder = pushBubble('assistant', '', target.id);
    openBubbles.set(target.id, {
      el: placeholder,
      bodyEl: placeholder._bodyEl,
      typingEl: placeholder._typingEl,
      hasContent: false,
    });

    const r = await transport.workers.send({ to: target.id, text });
    if (r && r.ok === false) pushBubble('system', `send failed: ${r.error || 'unknown'}`);
  }

  // --- Mention popup / slash popup / autoGrow / popup keyboard nav -------
  // All moved into <compose-input> (renderer/components/compose-input.js).
  // The component owns the textarea + popup; we listen for its
  // 'submit' event and route through send() below.

  // (Removed in-line: updateInputPopup, currentWorkerTools, hidePopup,
  //  renderSlashPopup, acceptSlash, renderMentionPopup, updateMentionPopup.)

  // --- Wire-up -----------------------------------------------------------

  function init() {
    $('cmd-agent-manager')?.addEventListener('click', () => {
      const isHidden = rootEl().classList.contains('agent-manager--hidden');
      show(isHidden);
    });
    $('agent-manager-close')?.addEventListener('click', () => show(false));

    $('am-settings-toggle')?.addEventListener('click', () => toggleSettings());

    // <empty-state> custom element dispatches a 'spawn' event with
    // detail.kind. Its cwd picker is wired internally to actions.pickCwd.
    $('am-empty-state')?.addEventListener('spawn', (/** @type {any} */ ev) => {
      const kind = ev?.detail?.kind;
      if (kind) spawnWorker(kind);
    });
    // <worker-chips> dispatches 'select' (detail.id) on click. The
    // component already calls selectWorker(id) (which updates the
    // store); here we just refocus the compose input so the user
    // can immediately type at the chosen worker.
    $('am-workers')?.addEventListener('select', () => inputEl()?.focus());
    // <settings-drawer> emits its own events for everything that's not
    // a pure store-mutation. spawn → spawnWorker(kind), system-message
    // → pushBubble('system', ...). Persisted settings (chat side, tool
    // details, auto-context, mirror toggles, generation model, default
    // explain, semantic device) all route through actions/store directly.
    settingsEl()?.addEventListener('spawn', (/** @type {any} */ ev) => {
      const kind = ev?.detail?.kind;
      if (kind) spawnWorker(kind);
    });
    settingsEl()?.addEventListener('system-message', (/** @type {any} */ ev) => {
      const text = ev?.detail?.text;
      if (text) pushBubble('system', text);
    });

    // <compose-input> handles the textarea + popup + Enter/Send + autogrow
    // internally. It dispatches a 'submit' event with detail.text when the
    // user hits Enter (without Shift) or clicks the Send button. We route
    // that text through the existing send() path.
    composeEl()?.addEventListener('submit', (/** @type {any} */ ev) => {
      const text = ev?.detail?.text;
      if (typeof text === 'string') send(text).catch(() => {});
    });

    // All persisted settings (mirror toggles, auto-context, chat side,
    // tool details, semantic device, generation model, default explain)
    // are owned by <settings-drawer>. The component hydrates from
    // transport.settings on connectedCallback and writes back via the
    // store + actions.

    // Test hook: tests change the persisted toolDetails setting via
    // transport.settings.set() then call this to sync the renderer's
    // cache without waiting for next init. We re-read the setting and
    // mirror it into the store so chat-bubble / tool-card render
    // with the right mode.
    /** @type {any} */ (window).__amTestRefreshToolDetails = async () => {
      try {
        const r = await transport.settings.get('toolDetails', 'collapsed');
        const v = r.value || 'collapsed';
        const td = (v === 'expanded' || v === 'hidden') ? v : 'collapsed';
        const ns = store.get();
        store.update({ settings: { ...ns.settings, toolDetails: td } });
      } catch { /* ignore */ }
    };
    // Test hook: tests close workers via transport directly, then call
    // this to make the renderer's worker list reflect main-process state
    // without waiting for the 3-second auto-refresh tick.
    /** @type {any} */ (window).__amTestRefreshAll = refreshAll;

    // Named handlers so the test hook (window.__amTestFireEvent)
    // can synthesize events without going through real IPC.
    const handlers = {
      'chat:user': (msg) => {
        const opt = pendingUserOptimistic;
        if (opt && opt.agentId === msg.agentId && opt.text === msg.text) {
          pendingUserOptimistic = null;
        } else {
          pushBubble('user', msg.text, msg.agentId);
        }
        // Flush any pending context badge that arrived BEFORE the
        // user bubble was findable. Common in production where the
        // manager fires chat:context-used and chat:user back-to-back.
        if (pendingContextBadges && pendingContextBadges.has(msg.agentId)) {
          const pending = pendingContextBadges.get(msg.agentId);
          pendingContextBadges.delete(msg.agentId);
          attachContextBadge(pending);
        }
      },
      'chat:turn-start': (msg) => {
        state.thinkingWorkers.add(msg.agentId);
        renderWorkers();
      },
      'chat:chunk': (msg) => {
        const isSemantic = typeof msg.kind === 'string' && msg.kind.startsWith('semantic-');
        if (isSemantic) {
          renderSemanticResult(msg);
          return;
        }
        const isPlainText =
          !msg.kind ||
          msg.kind === 'text' ||
          msg.kind === 'shell-output' ||
          msg.kind === 'thinking';
        if (isPlainText) {
          appendToOpenBubble(msg.agentId, msg.text || '');
        } else if (msg.kind === 'tool-use') {
          renderToolUseCard(msg);
        } else if (msg.kind === 'tool-result') {
          renderToolResult(msg);
        }
      },
      'chat:turn-end': (msg) => {
        closeOpenBubble(msg.agentId);
        state.thinkingWorkers.delete(msg.agentId);
        renderWorkers();
      },
      'chat:error': (msg) => {
        pushBubble('system', msg.error || 'error');
        if (msg.agentId) {
          state.thinkingWorkers.delete(msg.agentId);
          renderWorkers();
        }
      },
      // Auto-context: WorkerManager retrieved memories before sending
      // the prompt. Find the most-recent matching user bubble for
      // this agent and attach a small clickable badge below it.
      'chat:context-used': (msg) => attachContextBadge(msg),
    };
    for (const [name, fn] of Object.entries(handlers)) {
      transport.chat.on(name, fn);
    }
    // Test hook: lets e2e tests synthesize chat:* events without
    // requiring a real worker subprocess. Production code paths
    // never call this — only Playwright does. Safe to expose
    // because all events are inert without a real worker context.
    window.__amTestFireEvent = (name, payload) => {
      const fn = handlers[name];
      if (fn) fn(payload || {});
    };

    document.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'a') {
        ev.preventDefault();
        const isHidden = rootEl().classList.contains('agent-manager--hidden');
        show(isHidden);
      }
    });

    show(true);
    setInterval(() => {
      if (!rootEl().classList.contains('agent-manager--hidden')) refreshAll();
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

init();
