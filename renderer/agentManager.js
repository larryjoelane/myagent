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
// re-render.
//
// <chat-log> owns its own internal state (openBubbles, pendingContextBadges)
// — see renderer/components/chat-log.js. The only chat-surface state
// that lives here is pendingUserOptimistic, used to suppress duplicate
// user bubbles when the optimistic write races with chat:user.

import { store } from './state/store.js';

let pendingUserOptimistic = null;

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
      // <settings-drawer> subscribes to the store and re-renders the
      // workers list and cwd label itself when state changes.
    } catch { /* ignore transient errors */ }
  }

  // cwd hydration + the cwd-picker action live in renderer/state/actions.js
  // (hydrateLastCwd, pickCwd). settings-drawer hydrates on connect; both
  // <empty-state> and <settings-drawer> read pendingCwd from the store and
  // wire @click directly to actions.pickCwd.

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
  //
  // <chat-log> owns: assistant bubbles, streaming text, tool cards,
  // semantic cards, the openBubbles map, context badges, and pending-
  // badge state. We expose thin pushBubble/closeOpenBubble shims here
  // because send() and the chat:* handlers below all call them; once
  // those call sites move into the component (or onto its event API),
  // these shims go away.

  function pushBubble(kind, text, agentId) {
    const c = /** @type {any} */ (chatEl());
    let wrap;
    if (kind === 'user') wrap = c.pushUser(text, agentId);
    else if (kind === 'system') wrap = c.pushSystem(text);
    else wrap = c.pushAssistant(agentId, text);
    renderEmptyState();
    return wrap;
  }

  function attachContextBadge(msg) {
    /** @type {any} */ (chatEl()).attachContextBadge(msg);
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
    const bubble = pushMemoryBubble(query);
    try {
      const searchOpts = {};
      if (typeof opts.limit === 'number') searchOpts.limit = opts.limit;
      if (typeof opts.minConfidence === 'number' && opts.minConfidence > 0) {
        searchOpts.minConfidence = opts.minConfidence;
      }
      const result = await transport.memory.search(query, searchOpts);
      const hits = (result && result.hits) || [];
      const totalCandidates = (result && typeof result.totalCandidates === 'number')
        ? result.totalCandidates
        : hits.length;
      bubble.setResults({
        query, hits, totalCandidates,
        minConfidence: opts.minConfidence || 0,
        showAll: !!opts.showAll,
      });
    } catch (err) {
      bubble.setError({ query, error: err.message });
    }
  }

  // Help bubble: shows command syntax. Triggered by `@memory`,
  // `@memory --help`, `@memory help`. Doesn't go through the
  // search path — pure documentation.
  function pushMemoryHelpBubble() {
    const el = /** @type {any} */ (document.createElement('memory-bubble'));
    el.setHelp({ defaultMinConfidence: DEFAULT_MIN_CONFIDENCE });
    chatEl().appendChild(el);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
    return el;
  }

  function pushUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble bubble--user';
    wrap.textContent = text;
    chatEl().appendChild(wrap);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
  }

  function pushMemoryBubble(query) {
    const el = /** @type {any} */ (document.createElement('memory-bubble'));
    el.setSearching({ query });
    chatEl().appendChild(el);
    renderEmptyState();
    chatEl().scrollTop = chatEl().scrollHeight;
    return el;
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

    /** @type {any} */ (chatEl()).openAssistantBubble(target.id);

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

    // <memory-bubble> dispatches 'insert-snippet' (bubbles, composed) when
    // a hit is clicked. Route the full snippet text into the compose input.
    chatEl()?.addEventListener('insert-snippet', (/** @type {any} */ ev) => {
      const text = ev?.detail?.text;
      if (typeof text === 'string' && text) composeEl()?.appendValue(text);
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
        /** @type {any} */ (chatEl()).flushPendingContextBadge(msg.agentId);
      },
      'chat:turn-start': (msg) => {
        state.thinkingWorkers.add(msg.agentId);
        renderWorkers();
      },
      'chat:chunk': (msg) => {
        /** @type {any} */ (chatEl()).chunk(msg);
      },
      'chat:turn-end': (msg) => {
        /** @type {any} */ (chatEl()).closeBubble(msg.agentId);
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
