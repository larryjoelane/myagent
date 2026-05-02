// AgentManager — chat surface that drives headless workers.
//
// Workers are managed via transport.workers.{spawn, list, send, close,
// rename}. Each worker is a claude headless subprocess or a shell.
// The chat input routes to the currently-selected worker, or by
// @-mention to a specific one. Responses stream in via chat:* IPC
// events broadcast from main.js.

(function () {
  const transport = window.transport;
  if (!transport || !transport.workers || !transport.chat) return;

  const $ = (id) => document.getElementById(id);

  const state = {
    workers: [],          // [{id, name, kind, cwd, memoryMirror}]
    currentTarget: null,  // worker id (or "shell" name)
    openBubbles: new Map(),
    pendingUserOptimistic: null,
    settings: { defaultMirror: true, toolDetails: 'collapsed' },
    thinkingWorkers: new Set(),
    pendingCwd: null,     // user's chosen cwd for the next spawn
    // Tool list per worker id, fetched on spawn for kinds that
    // expose a toolkit (semantic). Drives slash-command autocomplete.
    // The toolkit is currently immutable per spawn — if that changes,
    // refetch on a `worker:tools-changed` event.
    toolsByWorker: new Map(),
    // Selected index in the slash popup, for keyboard navigation.
    slashSelected: 0,
  };

  function rootEl() { return $('agent-manager'); }
  function chatEl() { return $('am-chat'); }
  function workersEl() { return $('am-workers'); }
  function emptyEl() { return $('am-empty-state'); }
  function inputEl() { return $('am-input'); }
  function mentionEl() { return $('am-mention-popup'); }
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
    state.settings.settingsOpen = (open == null) ? !state.settings.settingsOpen : !!open;
    el.classList.toggle('agent-manager__settings--hidden', !state.settings.settingsOpen);
    if (state.settings.settingsOpen) renderSettings();
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
      if (state.settings.settingsOpen) renderSettings();
    } catch { /* ignore transient errors */ }
  }

  function shortenPath(p) {
    if (!p) return '(default)';
    // Show last two path segments for compactness, e.g. ".../source/MyAgent".
    const parts = p.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return p;
    return '…/' + parts.slice(-2).join('/');
  }

  // Sync the cwd label on every spawn entry point. There are two
  // pickers in the UI:
  //   - empty-state picker (shown before the first worker exists)
  //   - settings-drawer picker (shown once workers are attached so
  //     users don't have to close everything just to change cwd)
  // Both write to the same `state.pendingCwd`, so both labels need
  // to reflect the current value after every change.
  async function renderEmptyCwd() {
    if (!state.pendingCwd) {
      try {
        const r = await transport.settings.get('lastCwd');
        state.pendingCwd = r.value || null;
      } catch { /* ignore */ }
    }
    const label = state.pendingCwd ? shortenPath(state.pendingCwd) : '(repo root)';
    const tooltip = state.pendingCwd || '(repo root)';
    for (const [textId, btnId] of [
      ['am-empty-cwd-text', 'am-empty-cwd'],
      ['am-spawn-cwd-text', 'am-spawn-cwd'],
    ]) {
      const t = $(textId);
      if (t) t.textContent = label;
      const b = $(btnId);
      if (b) b.title = tooltip;
    }
  }

  async function pickCwd() {
    try {
      const r = await transport.dialog.chooseDirectory({ defaultPath: state.pendingCwd });
      if (r.canceled || !r.path) return;
      state.pendingCwd = r.path;
      await renderEmptyCwd();
    } catch { /* ignore */ }
  }

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
    empty.classList.toggle('agent-manager__empty--hidden', !showEmpty);
    chat.classList.toggle('agent-manager__chat--hidden', showEmpty);
  }

  function renderWorkers() {
    const host = workersEl();
    host.innerHTML = '';
    for (const w of state.workers) {
      const chip = document.createElement('div');
      chip.className = 'worker-chip';
      if (w.id === state.currentTarget) chip.classList.add('worker-chip--active');
      if (state.thinkingWorkers.has(w.id)) chip.classList.add('worker-chip--thinking');
      chip.title = `${w.kind}\ncwd: ${w.cwd || '(default)'}\nid: ${w.id}`;

      const label = document.createElement('span');
      label.className = 'worker-chip__label';
      label.textContent = `@${w.name}`;
      label.addEventListener('click', () => selectTarget(w.id));
      chip.appendChild(label);
      host.appendChild(chip);
    }
  }

  function renderSettings() {
    const detail = $('am-workers-detail');
    if (!detail) return;
    detail.innerHTML = '';
    if (state.workers.length === 0) {
      const p = document.createElement('div');
      p.style.cssText = 'color: var(--text-faint); font-size: 11px; padding: 6px 0;';
      p.textContent = 'No workers. Spawn one from the empty state.';
      detail.appendChild(p);
      return;
    }
    for (const w of state.workers) {
      const row = document.createElement('div');
      row.className = 'am-worker-row';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'am-worker-row__name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = w.name;
      nameInput.title = `${w.kind} · rename`;
      nameInput.addEventListener('change', async () => {
        const newName = (nameInput.value || '').trim();
        if (!newName || newName === w.name) { nameInput.value = w.name; return; }
        const r = await transport.workers.rename({ id: w.id, name: newName });
        if (!r.ok) { pushBubble('system', `rename failed: ${r.error}`); nameInput.value = w.name; }
        await refreshAll();
      });
      nameWrap.appendChild(nameInput);
      row.appendChild(nameWrap);

      const meta = document.createElement('span');
      meta.style.cssText = 'font-size: 10px; color: var(--text-faint); flex: 0 0 auto;';
      meta.textContent = w.kind;
      meta.title = w.cwd ? `${w.kind} · ${w.cwd}` : w.kind;
      row.appendChild(meta);

      if (w.cwd) {
        const cwdLine = document.createElement('span');
        cwdLine.style.cssText = 'font-size: 10px; color: var(--text-faint); font-family: \'Cascadia Code\', monospace; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto;';
        cwdLine.textContent = shortenPath(w.cwd);
        cwdLine.title = w.cwd;
        row.appendChild(cwdLine);
      }

      const mirrorOn = (typeof w.memoryMirror === 'boolean') ? w.memoryMirror : state.settings.defaultMirror;
      const mirrorLabel = document.createElement('label');
      mirrorLabel.style.cssText = 'display: inline-flex; gap: 4px; align-items: center; font-size: 11px; color: var(--text-dim); cursor: pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = mirrorOn;
      cb.addEventListener('change', async () => {
        await transport.chat.setWorkerMirror(w.id, cb.checked);
        await refreshAll();
      });
      mirrorLabel.appendChild(cb);
      const mirrorText = document.createElement('span');
      mirrorText.textContent = 'save';
      mirrorLabel.appendChild(mirrorText);
      row.appendChild(mirrorLabel);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'cmd-btn cmd-btn--small';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', async () => {
        await transport.workers.close({ id: w.id });
        state.toolsByWorker.delete(w.id);
        await refreshAll();
      });
      row.appendChild(closeBtn);

      detail.appendChild(row);
    }
  }

  function selectTarget(id) {
    state.currentTarget = id;
    renderWorkers();
    inputEl()?.focus();
  }

  // --- Spawn flow --------------------------------------------------------

  async function spawnWorker(kind) {
    const r = await transport.workers.spawn({ kind, cwd: state.pendingCwd || undefined });
    if (!r.ok) { pushBubble('system', `spawn failed: ${r.error || 'unknown'}`); return; }
    state.currentTarget = r.id;
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
      state.pendingContextBadges = state.pendingContextBadges || new Map();
      state.pendingContextBadges.set(agentId, msg);
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

  // Auto-grow the textarea to fit its content, up to its CSS
  // max-height. We set height to 'auto' first so scrollHeight
  // reflects the natural content height (otherwise it stays at the
  // current set value). Cap at parent-derived max so the box can't
  // overflow visually past its CSS limit.
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight excludes the textarea's border, so add it back.
    const border = (el.offsetHeight - el.clientHeight) || 0;
    el.style.height = (el.scrollHeight + border) + 'px';
  }

  function insertSnippet(text) {
    if (!text) return;
    const input = inputEl();
    if (!input) return;
    // Strip any trailing "[tags: ...]" line that storeMemory adds
    // before saving — those are bookkeeping, not content.
    const cleaned = text.replace(/\n\[tags:[^\]]*\]\s*$/, '');
    const current = input.value;
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    input.value = current + sep + cleaned;
    input.focus();
    // Move cursor to end.
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
  }

  function appendToOpenBubble(agentId, text) {
    let entry = state.openBubbles.get(agentId);
    if (!entry) {
      const el = pushBubble('assistant', '', agentId);
      entry = { el, bodyEl: el._bodyEl, typingEl: el._typingEl, hasContent: false };
      state.openBubbles.set(agentId, entry);
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
    let entry = state.openBubbles.get(agentId);
    if (!entry) {
      const el = pushBubble('assistant', '', agentId);
      entry = { el, bodyEl: el._bodyEl, typingEl: el._typingEl, hasContent: false };
      state.openBubbles.set(agentId, entry);
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
    const entry = state.openBubbles.get(agentId);
    if (!entry) return;
    entry.el.classList.add('bubble--done');
    if (!entry.hasContent && entry.typingEl) {
      entry.typingEl.parentNode.removeChild(entry.typingEl);
      entry.bodyEl.textContent = '(no response)';
      entry.bodyEl.style.color = 'var(--text-faint)';
    }
    state.openBubbles.delete(agentId);
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

  async function send() {
    const input = inputEl();
    const raw = input.value;
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
      input.value = '';
      input.style.height = '';
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

    state.pendingUserOptimistic = { agentId: target.id, text };
    pushBubble('user', text, target.id);
    input.value = '';
    // Reset to the CSS-defined min height; otherwise the inline
    // height we set during autoGrow keeps the box at the grown size.
    input.style.height = '';

    const placeholder = pushBubble('assistant', '', target.id);
    state.openBubbles.set(target.id, {
      el: placeholder,
      bodyEl: placeholder._bodyEl,
      typingEl: placeholder._typingEl,
      hasContent: false,
    });

    const r = await transport.workers.send({ to: target.id, text });
    if (r && r.ok === false) pushBubble('system', `send failed: ${r.error || 'unknown'}`);
  }

  // --- Mention popup ------------------------------------------------------

  // Single dispatcher: figure out whether the textarea is in slash-
  // command mode, mention mode, or neither, and render accordingly.
  // Slash mode wins when the input begins with `/`; the slash command
  // is only valid at column 0 of the textarea (matches what the
  // SemanticDriver's parseSlash() accepts).
  function updateInputPopup() {
    const input = inputEl();
    const popup = mentionEl();
    const text = input.value;
    const cursor = input.selectionStart || 0;
    const before = text.slice(0, cursor);

    // Slash mode: only when `/` is the very first character of the
    // textarea AND the active worker is semantic (others have no
    // toolkit to autocomplete from).
    if (text.startsWith('/')) {
      const tools = currentWorkerTools();
      if (tools && tools.length > 0) {
        renderSlashPopup(input, popup, text);
        return;
      }
    }

    // @-mention mode (existing behavior).
    const m = before.match(/(?:^|\s)@(\S*)$/);
    if (!m) { hidePopup(popup); return; }
    renderMentionPopup(input, popup, before, cursor, text, m[1].toLowerCase());
  }

  function currentWorkerTools() {
    const w = workerById(state.currentTarget);
    if (!w || w.kind !== 'semantic') return null;
    return state.toolsByWorker.get(w.id) || null;
  }

  function hidePopup(popup) {
    popup.classList.add('mention-popup--hidden');
    state.slashSelected = 0;
  }

  function renderSlashPopup(input, popup, text) {
    // Parse `/cmd args` out of the start of the input. The user is
    // typing the cmd portion; everything after the first space is
    // the args (we don't rewrite that on accept).
    const m = text.match(/^\/([a-zA-Z0-9_-]*)/);
    const typedCmd = (m && m[1]) ? m[1].toLowerCase() : '';
    const tools = state.toolsByWorker.get(state.currentTarget) || [];

    // Always show /help even though it's not a tool id — it's a real
    // slash command in the SemanticDriver. Synthesize an entry.
    const entries = [
      { id: 'help', name: 'Help', description: 'List all tools or show help for one.' },
      ...tools,
    ];
    const matches = entries.filter((t) => t.id.toLowerCase().includes(typedCmd));

    popup.innerHTML = '';
    if (matches.length === 0) {
      const item = document.createElement('div');
      item.className = 'mention-item';
      item.style.color = 'var(--text-faint)';
      item.style.fontStyle = 'italic';
      item.textContent = `no slash commands match "/${typedCmd}"`;
      popup.appendChild(item);
      popup.classList.remove('mention-popup--hidden');
      return;
    }

    // Clamp the selection index to the matches we just rebuilt.
    if (state.slashSelected >= matches.length) state.slashSelected = matches.length - 1;
    if (state.slashSelected < 0) state.slashSelected = 0;

    matches.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'mention-item mention-item--slash';
      if (i === state.slashSelected) item.classList.add('mention-item--active');
      const head = document.createElement('div');
      head.className = 'mention-item__head';
      head.textContent = `/${t.id}`;
      const sub = document.createElement('div');
      sub.className = 'mention-item__sub';
      // First sentence of the description — keep the row tight.
      sub.textContent = (t.description || '').split(/(?<=\.)\s/)[0].slice(0, 90);
      item.appendChild(head);
      if (sub.textContent) item.appendChild(sub);
      item.dataset.index = String(i);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        acceptSlash(input, popup, text, t.id);
      });
      popup.appendChild(item);
    });
    popup.classList.remove('mention-popup--hidden');
  }

  function acceptSlash(input, popup, text, toolId) {
    // Replace just the leading `/cmd`, keep any trailing args + space.
    const rest = text.replace(/^\/[a-zA-Z0-9_-]*/, '');
    const next = `/${toolId}${rest.length === 0 ? ' ' : rest}`;
    input.value = next;
    input.focus();
    // Cursor goes to the end of the inserted command (before any args
    // the user already had typed) so they can immediately type args.
    const cursor = `/${toolId}`.length + (rest.length === 0 ? 1 : 0);
    input.setSelectionRange(cursor, cursor);
    hidePopup(popup);
  }

  function renderMentionPopup(input, popup, before, cursor, text, prefix) {
    const matches = state.workers.filter((w) => w.name.toLowerCase().includes(prefix));
    popup.innerHTML = '';
    if (matches.length === 0) {
      const item = document.createElement('div');
      item.className = 'mention-item';
      item.style.color = 'var(--text-faint)';
      item.style.fontStyle = 'italic';
      item.textContent = 'no workers — spawn one first';
      popup.appendChild(item);
    } else {
      for (const w of matches) {
        const item = document.createElement('div');
        item.className = 'mention-item';
        item.textContent = `@${w.name} (${w.kind})`;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const head = before.replace(/(^|\s)@\S*$/, `$1@${w.name} `);
          input.value = head + text.slice(cursor);
          input.focus();
          const newPos = head.length;
          input.setSelectionRange(newPos, newPos);
          popup.classList.add('mention-popup--hidden');
        });
        popup.appendChild(item);
      }
    }
    popup.classList.remove('mention-popup--hidden');
  }

  // Backwards-compat shim — old call sites still reference this name.
  function updateMentionPopup() { updateInputPopup(); }

  // --- Wire-up -----------------------------------------------------------

  function init() {
    $('cmd-agent-manager')?.addEventListener('click', () => {
      const isHidden = rootEl().classList.contains('agent-manager--hidden');
      show(isHidden);
    });
    $('agent-manager-close')?.addEventListener('click', () => show(false));

    $('am-settings-toggle')?.addEventListener('click', () => toggleSettings());

    $('am-empty-spawn-claude')?.addEventListener('click', () => spawnWorker('claude'));
    $('am-empty-spawn-shell')?.addEventListener('click', () => spawnWorker('shell'));
    $('am-empty-spawn-semantic')?.addEventListener('click', () => spawnWorker('semantic'));
    $('am-empty-cwd')?.addEventListener('click', () => pickCwd());
    // Settings-drawer cwd picker — same handler, different button.
    // Both write to state.pendingCwd; renderEmptyCwd() syncs both labels.
    $('am-spawn-cwd')?.addEventListener('click', () => pickCwd());

    // Settings-drawer spawn buttons — the way to add workers once
    // the empty state is gone.
    $('am-spawn-claude')?.addEventListener('click', async () => {
      // Pick a cwd first if the user wants — same picker as empty state.
      // For now, reuse the persisted lastCwd / pendingCwd silently. Users
      // who want a different folder can explicitly pick before spawning
      // when the picker UX matures.
      await spawnWorker('claude');
    });
    $('am-spawn-shell')?.addEventListener('click', async () => {
      await spawnWorker('shell');
    });
    $('am-spawn-semantic')?.addEventListener('click', async () => {
      await spawnWorker('semantic');
    });

    $('am-send')?.addEventListener('click', () => send().catch(() => {}));
    const input = inputEl();
    if (input) {
      input.addEventListener('keydown', (e) => {
        // Slash-popup keyboard navigation. Active only when the popup
        // is visible AND the textarea begins with `/`. We treat any
        // other state as "popup not for me" and fall through to normal
        // textarea behavior (so Enter still sends, etc.).
        const popup = mentionEl();
        const slashOpen = !popup.classList.contains('mention-popup--hidden')
          && input.value.startsWith('/');
        if (slashOpen) {
          const items = popup.querySelectorAll('.mention-item--slash');
          if (e.key === 'Escape') {
            e.preventDefault();
            hidePopup(popup);
            return;
          }
          if (items.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const dir = e.key === 'ArrowDown' ? 1 : -1;
            state.slashSelected = (state.slashSelected + dir + items.length) % items.length;
            updateInputPopup();
            return;
          }
          if (items.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
            e.preventDefault();
            const sel = items[state.slashSelected];
            const idx = Number(sel?.dataset.index || 0);
            // Re-derive the entries the same way renderSlashPopup does.
            const tools = state.toolsByWorker.get(state.currentTarget) || [];
            const entries = [
              { id: 'help' },
              ...tools,
            ];
            const m = input.value.match(/^\/([a-zA-Z0-9_-]*)/);
            const typed = (m && m[1]) ? m[1].toLowerCase() : '';
            const matches = entries.filter((t) => t.id.toLowerCase().includes(typed));
            const pick = matches[idx];
            if (pick) acceptSlash(input, popup, input.value, pick.id);
            return;
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send().catch(() => {});
        }
      });
      input.addEventListener('input', () => {
        autoGrow(input);
        // Reset selection when the input changes — we can't carry an
        // index across a different filter result set sensibly.
        state.slashSelected = 0;
        updateInputPopup();
      });
      input.addEventListener('blur', () => {
        setTimeout(() => mentionEl().classList.add('mention-popup--hidden'), 100);
      });
    }

    const defMirror = $('am-default-mirror');
    if (defMirror) {
      defMirror.addEventListener('change', async () => {
        await transport.chat.setDefaultMirror(defMirror.checked);
        const r = await transport.chat.getSettings();
        state.settings.defaultMirror = r.defaultMirror;
        await refreshAll();
      });
    }
    transport.chat.getSettings().then((r) => {
      state.settings.defaultMirror = r.defaultMirror;
      if (defMirror) defMirror.checked = r.defaultMirror;
    }).catch(() => {});

    // Auto-context: when on, the WorkerManager runs a memory search
    // before each send and prepends a context preamble. Default on.
    const autoCtx = $('am-auto-context');
    transport.settings.get('autoContext', true).then((r) => {
      const on = r.value !== false;
      if (autoCtx) autoCtx.checked = on;
    }).catch(() => {});
    if (autoCtx) {
      autoCtx.addEventListener('change', async () => {
        await transport.settings.set('autoContext', autoCtx.checked);
      });
    }

    // Chat-side preference. Persists across launches; flips the
    // app-row flex direction so the chat docks on the chosen side.
    const applyChatSide = (side) => {
      const row = document.getElementById('app-row');
      if (!row) return;
      const isRight = side === 'right';
      row.classList.toggle('app-row--chat-right', isRight);
      $('am-chat-side-left')?.classList.toggle('cmd-btn--active', !isRight);
      $('am-chat-side-right')?.classList.toggle('cmd-btn--active', isRight);
    };
    transport.settings.get('chatSide', 'left').then((r) => applyChatSide(r.value || 'left')).catch(() => {});
    $('am-chat-side-left')?.addEventListener('click', async () => {
      applyChatSide('left');
      await transport.settings.set('chatSide', 'left');
    });
    $('am-chat-side-right')?.addEventListener('click', async () => {
      applyChatSide('right');
      await transport.settings.set('chatSide', 'right');
    });

    // Tool details preference: 'expanded' | 'collapsed' (default) |
    // 'hidden'. Cached in state.settings.toolDetails so the
    // renderer doesn't need to await on every card.
    async function refreshToolDetails() {
      try {
        const r = await transport.settings.get('toolDetails', 'collapsed');
        const v = r.value || 'collapsed';
        state.settings.toolDetails = (v === 'expanded' || v === 'hidden') ? v : 'collapsed';
        // Reflect in the segmented control if present.
        for (const mode of ['expanded', 'collapsed', 'hidden']) {
          $(`am-tool-details-${mode}`)?.classList.toggle('cmd-btn--active', state.settings.toolDetails === mode);
        }
      } catch { /* ignore */ }
    }
    refreshToolDetails();
    // Test hook: tests change the persisted setting then call this
    // to sync the in-renderer cache without waiting for next init.
    window.__amTestRefreshToolDetails = refreshToolDetails;
    for (const mode of ['expanded', 'collapsed', 'hidden']) {
      $(`am-tool-details-${mode}`)?.addEventListener('click', async () => {
        await transport.settings.set('toolDetails', mode);
        await refreshToolDetails();
      });
    }

    // Named handlers so the test hook (window.__amTestFireEvent)
    // can synthesize events without going through real IPC.
    const handlers = {
      'chat:user': (msg) => {
        const opt = state.pendingUserOptimistic;
        if (opt && opt.agentId === msg.agentId && opt.text === msg.text) {
          state.pendingUserOptimistic = null;
        } else {
          pushBubble('user', msg.text, msg.agentId);
        }
        // Flush any pending context badge that arrived BEFORE the
        // user bubble was findable. Common in production where the
        // manager fires chat:context-used and chat:user back-to-back.
        if (state.pendingContextBadges && state.pendingContextBadges.has(msg.agentId)) {
          const pending = state.pendingContextBadges.get(msg.agentId);
          state.pendingContextBadges.delete(msg.agentId);
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
})();
