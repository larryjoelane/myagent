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
import { spawnWorker as spawnWorkerAction } from './state/actions.js';
import { tryHandleMemoryCommand } from './commands/memory.js';
import { tryHandleAttachCommand, listStaged, clearStaged, buildAttachPreamble } from './commands/attach.js';

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

  function shellEl() { return /** @type {any} */ ($('agent-manager')); }
  function chatEl() { return $('am-chat'); }
  function workersEl() { return $('am-workers'); }
  function composeEl() { return /** @type {any} */ ($('am-compose')); }
  function inputEl() { return composeEl(); }

  function show(open) {
    const shell = shellEl();
    if (shell) shell.open = !!open;
    if (open) {
      refreshAll();
      setTimeout(() => inputEl()?.focus(), 200);
    }
  }

  // --- Worker list refresh -----------------------------------------------

  async function refreshAll() {
    try {
      const r = await transport.workers.list();
      state.workers = (r.workers || []).map((w) => ({
        id: w.id, name: w.name, kind: w.kind, cwd: w.cwd, memoryMirror: w.memoryMirror,
      }));
      renderWorkers();
      // <empty-state> subscribes to the store and self-toggles its
      // visibility (and the legacy --hidden class on chat-log).
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
  //
  // Empty-state visibility is owned by <empty-state> itself — see
  // renderer/components/empty-state.js. It subscribes to the store
  // and shows itself whenever workers.length === 0. The chat surface
  // stays visible alongside so a "pick a worker first" error bubble
  // doesn't hide the spawn buttons.

  // <worker-chips> renders the strip from the store. Calling
  // renderWorkers() is now just "tell subscribers state changed" —
  // the component handles the DOM. The function name stays for the
  // existing call sites; once they're all componentized this becomes
  // dead and goes away.
  function renderWorkers() {
    store.bump();
    syncComposerBusy();
  }

  function syncComposerBusy() {
    const el = /** @type {any} */ (composeEl());
    if (!el) return;
    const id = state.currentTarget;
    const busy = !!(id && state.thinkingWorkers.has(id));
    if (el.busy !== busy) el.busy = busy;
  }

  // <worker-chips> updates state.currentTarget through the store on
  // click; we only need to focus the compose input afterwards. The
  // event listener for that is wired in init() — see workersEl()
  // 'select' handler.

  // --- Spawn flow --------------------------------------------------------
  //
  // The transport call, toolkit cache, and refresh all live in
  // actions.spawnWorker. Here we just surface failures as a system
  // bubble — successes are visible via the worker chip strip update.

  async function spawnWorker(kind, opts = {}) {
    const r = await spawnWorkerAction(kind, opts);
    if (!r.ok) {
      pushBubble('system', `spawn failed: ${r.error || 'unknown'}`);
    }
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
    if (kind === 'user') return c.pushUser(text, agentId);
    if (kind === 'system') return c.pushSystem(text);
    return c.pushAssistant(agentId, text);
  }

  function attachContextBadge(msg) {
    /** @type {any} */ (chatEl()).attachContextBadge(msg);
  }

  // @memory built-in lives in renderer/commands/memory.js. Wired into
  // send() below.


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

    // Built-in @memory command. Reserved name; never resolves to a
    // worker even if one is somehow named "memory". See
    // renderer/commands/memory.js for the full command grammar.
    if (await tryHandleMemoryCommand(raw, chatEl())) {
      compose?.clear();
      return;
    }

    // Built-in /attach command — stages files for the next message.
    // Self-contained: the command bubble is informational; no send.
    if (tryHandleAttachCommand(raw, { pushBubble })) {
      compose?.clear();
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

    // If files were staged via /attach, read them now and prepend a
    // preamble before sending. The worker sees the file content; the
    // user bubble shows the original `text`. A chip-badge under the
    // user bubble surfaces what was attached (mirrors auto-context).
    let toSend = text;
    let attachSources = [];
    if (listStaged().length > 0) {
      const built = await buildAttachPreamble(transport.fs);
      if (built.preamble) toSend = built.preamble + text;
      attachSources = built.sources || [];
      clearStaged();
    }

    pendingUserOptimistic = { agentId: target.id, text };
    pushBubble('user', text, target.id);
    compose?.clear();

    if (attachSources.length > 0) {
      // Render the attach badge on the just-pushed user bubble.
      // Reuse the chat-log's context-badge plumbing by emitting a
      // synthetic chat:context-used with our fileSource — it'll find
      // the user bubble (matching by text + agentId) and attach.
      // We pass usedHits=[] so only the file row renders.
      /** @type {any} */ (chatEl()).attachContextBadge({
        agentId: target.id,
        userText: text,
        usedHits: [],
        fileSource: { path: attachSources.map((s) => s.path).join(', '), dirty: false, attached: true },
      });
    }

    /** @type {any} */ (chatEl()).openAssistantBubble(target.id);

    const sendBody = (toSend === text)
      ? { to: target.id, text }
      : { to: target.id, text: toSend, originalText: text };
    const r = await transport.workers.send(sendBody);
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
    document.querySelector('topbar-commands')?.addEventListener('chat-toggle', () => {
      const shell = shellEl();
      show(!shell?.open);
    });
    // <agent-manager> shell owns its own close button and settings ⚙
    // toggle; we just listen for the events it emits.
    shellEl()?.addEventListener('close', () => show(false));

    // <empty-state> custom element dispatches a 'spawn' event with
    // detail.kind. Its cwd picker is wired internally to actions.pickCwd.
    $('am-empty-state')?.addEventListener('spawn', (/** @type {any} */ ev) => {
      const kind = ev?.detail?.kind;
      const model = ev?.detail?.model;
      if (kind) spawnWorker(kind, model ? { model } : {});
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
    $('am-settings')?.addEventListener('spawn', (/** @type {any} */ ev) => {
      const kind = ev?.detail?.kind;
      const model = ev?.detail?.model;
      if (kind) spawnWorker(kind, model ? { model } : {});
    });
    $('am-settings')?.addEventListener('system-message', (/** @type {any} */ ev) => {
      const text = ev?.detail?.text;
      if (text) pushBubble('system', text);
    });

    // <compose-input> handles the textarea + popup + Enter/Send + autogrow
    // internally. It dispatches a 'submit' event with detail.text when the
    // user hits Enter (without Shift) or clicks the Send button. We route
    // that text through the existing send() path. It also dispatches a
    // 'cancel' event when the user clicks the Stop button (shown while
    // the current target worker is mid-turn).
    composeEl()?.addEventListener('submit', (/** @type {any} */ ev) => {
      const text = ev?.detail?.text;
      if (typeof text === 'string') send(text).catch(() => {});
    });
    composeEl()?.addEventListener('cancel', () => {
      const id = state.currentTarget;
      if (!id) return;
      transport.workers.cancel?.({ id });
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
        // Pass the whole payload — closeBubble reads msg.error so the
        // error renders in-bubble even if chat:error didn't arrive
        // first (across-channel IPC ordering isn't guaranteed).
        /** @type {any} */ (chatEl()).closeBubble(msg.agentId, msg);
        state.thinkingWorkers.delete(msg.agentId);
        renderWorkers();
      },
      'chat:error': (msg) => {
        pushBubble('system', msg.error || 'error');
        // Also stash the error on any open assistant bubble for this
        // agent — covers the case where chat:error arrives before the
        // turn-end (the common case from drivers that emit both).
        if (msg.agentId) {
          /** @type {any} */ (chatEl()).errorBubble?.(msg.agentId, msg.error || 'error');
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
        const shell = shellEl();
        show(!shell?.open);
        return;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'd') {
        ev.preventDefault();
        const shell = /** @type {any} */ (shellEl());
        if (shell) shell.debugOpen = !shell.debugOpen;
      }
    });

    show(true);
    setInterval(() => {
      if (shellEl()?.open) refreshAll();
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

init();
