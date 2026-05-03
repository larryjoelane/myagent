const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');
const { Agent } = require('../src/core/agent');
const { createRunner, REGISTRY } = require('../src/core/runners');
const { runToolLoop } = require('../src/core/toolLoop');
const { SessionLog } = require('../src/core/sessionLog');
const { snapshotBefore, summarizeWindow } = require('../src/core/claudeSessionScan');
const { mirrorAll, groupSessionsByProject } = require('../src/core/memoryMirror');
const sessionServer = require('../src/core/sessionServer');
const { WorkerHost } = require('../src/core/sessionWorkerHost');
const { createAgentRegistry } = require('../src/core/agentRegistry');
const { WorkerManager } = require('../src/core/workerManager');
const { ClaudeDriver } = require('../src/core/drivers/claudeDriver');
const { ShellDriver } = require('../src/core/drivers/shellDriver');
const { AppSettings } = require('../src/core/appSettings');
const { BrowserManager } = require('../src/core/browserManager');
const { buildSemanticDriverFactory } = require('../src/core/semantic');
const { createEmbedderBridge } = require('../src/core/embedderBridge');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'project-output');
// Honor MYAGENT_SESSIONS_DIR for tests + advanced users — overrides
// the default per-repo sessions directory. When set, ALL state
// (memory index, app settings, session logs) lives there.
const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(PROJECT_ROOT, '.myagent', 'sessions');
// Our bin/ ships shims that intercept agent CLIs (currently `claude`)
// before they reach the real binary — that's where the pre-input hook
// runs. Prepending it to PATH for PTYs makes the shim win resolution
// without the user having to install anything globally.
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
// Obsidian-friendly memory mirror: per-project memory + session index.
const MEMORIES_DIR = path.join(SESSIONS_DIR, 'memories');
// Hybrid (FTS5 + vector) search index. Runs entirely in a worker thread —
// the main thread never opens the DB, never loads the embedder, never
// embeds. That's what keeps PTY keystroke handling responsive: model load
// (~3s WASM init) and per-row embedding (~30-80ms each) all happen off
// the thread that delivers `pty:input` / `pty:data` messages.
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');
const indexHost = new WorkerHost({
  dbPath: INDEX_DB_PATH,
  sessionsDir: SESSIONS_DIR,
});
function runIngest() { return indexHost.ensureIngested(); }

// In-memory leader/worker registry shared across all PTY-hosted agents
// in this app. Lives behind the loopback HTTP server so the bin/agent.js
// CLI can reach it from anywhere on the machine.
const agentRegistry = createAgentRegistry();

// Send a chat:* event to all renderer windows. Workers are window-
// agnostic — anyone with the AgentManager open should see updates.
function broadcastChat(event, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(event, payload);
  }
}

// Browser tabs — each tab is a BrowserView attached to a window. Events
// fan out to all renderers (same model as broadcastChat); the renderer
// that owns the tab filters by tabId.
const browserManager = new BrowserManager({
  onEvent: (event, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(event, payload);
    }
  },
});

// Persisted UI settings (last-used cwd for spawning workers, etc.).
// Lives in the same .myagent/ directory as the session index.
const appSettings = new AppSettings({
  file: path.join(SESSIONS_DIR, 'app-settings.json'),
});

// Auto-context provider: before each user prompt is sent to a
// worker, search memory for relevant past context and prepend it as
// a "Relevant past context" preamble. Silent — the worker sees an
// augmented prompt, but the chat:user event the UI displays is the
// original text. Failure here is non-fatal (provider returns empty).
//
// Tunables here are baselines; user override (toggle / threshold)
// lives in AppSettings (#61). See docs/memory-search.md for confidence
// scale rationale.
const AUTO_CONTEXT_DEFAULTS = {
  minConfidence: 0.6,    // tighter than chat default (0.5)
  maxHits: 3,            // top-k injected
  maxChars: 1500,        // hard cap on preamble size (~500 tokens)
};

async function autoContextProvider({ text }) {
  if (!appSettings.get('autoContext', true)) return { preamble: '', usedHits: [] };
  if (!text || !text.trim()) return { preamble: '', usedHits: [] };
  try {
    const hits = await indexHost.search({
      query: text,
      limit: AUTO_CONTEXT_DEFAULTS.maxHits,
      minConfidence: AUTO_CONTEXT_DEFAULTS.minConfidence,
    });
    if (!hits || hits.length === 0) return { preamble: '', usedHits: [] };
    // Build the preamble. Each line is a memory snippet; we trim
    // each to a reasonable size and stop adding when total chars
    // exceed maxChars so we don't blow up the context window.
    const lines = ['[Relevant past context — use if helpful]'];
    const used = [];
    let total = lines[0].length;
    for (const h of hits) {
      const body = (h.text || h.snippet || '').trim();
      if (!body) continue;
      const trimmed = body.length > 500 ? body.slice(0, 500) + '…' : body;
      const line = `- ${trimmed}`;
      if (total + line.length + 1 > AUTO_CONTEXT_DEFAULTS.maxChars) break;
      lines.push(line);
      total += line.length + 1;
      used.push({
        id: h.id,
        confidence: h.confidence,
        source: h.file,
        snippet: h.snippet,
        text: h.text,
      });
    }
    if (used.length === 0) return { preamble: '', usedHits: [] };
    return {
      preamble: lines.join('\n') + '\n\n',
      usedHits: used,
    };
  } catch {
    return { preamble: '', usedHits: [] };
  }
}

// Embedder bridge — hosts @huggingface/transformers in a hidden
// renderer BrowserWindow so it can target WebGPU. The semantic
// factory closes over this bridge so all semantic workers share
// one model load (and one hidden window).
let embedderBridge = null;
function getEmbedderBridge() {
  if (embedderBridge) return embedderBridge;
  embedderBridge = createEmbedderBridge({
    projectRoot: PROJECT_ROOT,
    BrowserWindow,
  });
  // Spawn the hidden window now (lazy was: on-first-spawn). Spawning
  // here means the WebGPU probe completes before the user clicks
  // "+ Spawn Semantic worker", so the device dropdown reflects truth.
  embedderBridge.start().catch((err) => {
    // Non-fatal: a failed bridge means semantic spawn will surface
    // the error when it tries to embed. Log so we at least see it.
    // eslint-disable-next-line no-console
    console.error('[embedder bridge] start failed:', err);
  });
  return embedderBridge;
}

// Semantic driver factory — built lazily so the WebGPU window isn't
// spawned until the user actually wants a semantic worker. The
// factory closes over the bridge so all semantic spawns share one
// model load.
let semanticFactory = null;
function getSemanticFactory() {
  if (semanticFactory) return semanticFactory;
  const bridge = getEmbedderBridge();
  semanticFactory = buildSemanticDriverFactory({
    embedder: { embed: (text, opts) => bridge.embed(text, opts || {}) },
    // Hand the indexHost's search through so the memory-search tool
    // talks to the same SQLite index every other piece of the app uses.
    search: (opts) => indexHost.search(opts),
    // memory-store tool writes to the same index (mirrors the existing
    // /memory/store HTTP route + memory:store IPC handler).
    store: (body) => indexHost.storeMemory(body),
    // Sandbox root for grep / read-file / git-log. Restricting to
    // PROJECT_ROOT means the agent can't pivot to /etc or another repo.
    root: PROJECT_ROOT,
  });
  return semanticFactory;
}

// WorkerManager owns spawn/list/send/close for chat-driven agents and
// shells. It hands forwarded events to broadcastChat so any open
// AgentManager renderer sees them. Memory mirror lives inside the
// manager — pass indexHost as the storage backend. The
// contextProvider wires auto-context retrieval into the send path.
const workerManager = new WorkerManager({
  factories: {
    claude: (opts) => new ClaudeDriver({ ...opts, cwd: opts.cwd || PROJECT_ROOT }),
    shell:  (opts) => new ShellDriver({ ...opts, cwd: opts.cwd || PROJECT_ROOT }),
    // Trampoline through getSemanticFactory so model load is deferred
    // until first spawn (saves ~3s + ~25MB on app startup).
    semantic: (opts) => getSemanticFactory()({ ...opts, cwd: opts.cwd || PROJECT_ROOT }),
  },
  onEvent: (name, payload) => broadcastChat(name, payload),
  memoryStore: { store: (body) => indexHost.storeMemory(body) },
  memoryMirrorDefault: true,
  contextProvider: autoContextProvider,
});

// Runner cache keyed by `${runnerName}::${model}`. Lazy — no runner is
// constructed (and no Ollama / model service is touched) until an
// `agent:*` IPC actually arrives. The renderer no longer calls these on
// startup; the agent UI was removed and will be rebuilt later.
const runnerCache = new Map();
function getRunner({ runnerName = 'ollama', model } = {}) {
  const key = `${runnerName}::${model || ''}`;
  if (!runnerCache.has(key)) {
    const opts = model ? { model } : {};
    runnerCache.set(key, createRunner(runnerName, opts));
  }
  return runnerCache.get(key);
}

// One log file per app launch. Captures everything that hits the
// terminals (agent + every PTY pane). Lives in .myagent/ which is
// gitignored. See src/core/sessionLog.js.
const sessionLog = new SessionLog({ dir: SESSIONS_DIR });

// PTY registry keyed by `${webContentsId}:${paneId}`. Each pane in the
// renderer can host its own PTY, so the same window may have several at
// once (one per pane). Once a shell exits its process is gone — `pty:start`
// always creates a fresh one for that key.
const ptys = new Map();
const ptyKey = (contentsId, paneId) => `${contentsId}:${paneId || 'main'}`;

// Application menu. Replaces Electron's default so we can add a DevTools
// toggle for the renderer (Ctrl+Shift+I or View → Toggle Developer Tools).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: (_item, win) => {
            const target = win || BrowserWindow.getFocusedWindow();
            target?.webContents.toggleDevTools();
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(PROJECT_ROOT, 'renderer', 'index.html'));

  win.webContents.on('destroyed', () => {
    const id = win.webContents.id;
    for (const [key, term] of ptys) {
      if (key.startsWith(`${id}:`)) {
        try { term.kill(); } catch { /* ignore */ }
        ptys.delete(key);
      }
    }
    agentRegistry.dropWhere((a) => a.webContentsId === id);
    browserManager.destroyAllForWindow(win);
  });
}

// ---- Browser tabs ----
// Renderer creates a tab, then reports the host element's bounds so
// the BrowserView can be positioned over it. Hide/show maps to
// addBrowserView/removeBrowserView (cheap; doesn't reload the page).
ipcMain.handle('browser:create', (event, body = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: 'no window' };
    browserManager.create({ tabId: body.tabId, win, url: body.url });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.on('browser:set-bounds', (_e, body = {}) => {
  if (!body.tabId) return;
  browserManager.setBounds(body.tabId, body.bounds || {});
});

ipcMain.on('browser:show', (_e, body = {}) => {
  if (body.tabId) browserManager.show(body.tabId);
});

ipcMain.on('browser:hide', (_e, body = {}) => {
  if (body.tabId) browserManager.hide(body.tabId);
});

ipcMain.handle('browser:destroy', (_e, body = {}) => {
  if (body.tabId) browserManager.destroy(body.tabId);
  return { ok: true };
});

ipcMain.handle('browser:load-url', async (_e, body = {}) => {
  try { return { ok: true, ...await browserManager.loadURL(body.tabId, body.url) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('browser:back', (_e, body = {}) => {
  try { browserManager.goBack(body.tabId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:forward', (_e, body = {}) => {
  try { browserManager.goForward(body.tabId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:reload', (_e, body = {}) => {
  try { browserManager.reload(body.tabId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:stop', (_e, body = {}) => {
  try { browserManager.stop(body.tabId); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Agent-control surface. Each call resolves with the JS evaluation
// result (or an {ok:false,error} on failure). Keep the wire format
// flat — these are the same shape worker tools will call.
ipcMain.handle('browser:click', async (_e, body = {}) => {
  try { return { ok: true, result: await browserManager.click(body.tabId, body.selector) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:type', async (_e, body = {}) => {
  try { return { ok: true, result: await browserManager.type(body.tabId, body.selector, body.text) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:eval', async (_e, body = {}) => {
  try { return { ok: true, result: await browserManager.evaluate(body.tabId, body.expression) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:wait-for', async (_e, body = {}) => {
  try { return { ok: true, result: await browserManager.waitForSelector(body.tabId, body.selector, { timeoutMs: body.timeoutMs }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:screenshot', async (_e, body = {}) => {
  try { return { ok: true, ...await browserManager.screenshot(body.tabId) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:get-text', async (_e, body = {}) => {
  try { return { ok: true, text: await browserManager.getText(body.tabId) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('browser:info', (_e, body = {}) => {
  try {
    return {
      ok: true,
      url: browserManager.url(body.tabId),
      title: browserManager.title(body.tabId),
    };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Health/think-status/set-think target the runner the renderer last used
// for this session. The renderer passes runnerName + model on every call
// so the main process is stateless w.r.t. which runner is "current."
ipcMain.handle('agent:health', async (_e, opts = {}) => getRunner(opts).health());

ipcMain.handle('agent:think-status', async (_e, opts = {}) => {
  const r = getRunner(opts);
  return { think: r.think, capabilities: r.capabilities, model: r.model };
});

ipcMain.handle('agent:set-think', async (_e, { on, ...opts } = {}) => {
  const r = getRunner(opts);
  const result = await r.setThink(on);
  return { ...result, capabilities: r.capabilities, model: r.model };
});

// List installed runners so the renderer can validate /agent --runner X.
ipcMain.handle('agent:runners', async () => Object.keys(REGISTRY));

ipcMain.on('agent:run', async (event, { sessionId, prompt, runnerName, model } = {}) => {
  const send = (channel, payload) =>
    event.sender.send(channel, { sessionId, ...payload });

  const PANE = 'main';
  sessionLog.text('agent-in', prompt, PANE);

  try {
    const runner = getRunner({ runnerName, model });
    const agent = new Agent({ runner });

    const { truncated, reason } = await runToolLoop({
      agent,
      userPrompt: prompt,
      outputDir: OUTPUT_DIR,
      onChunk: (text) => {
        sessionLog.text('agent-out', text, PANE);
        send('agent:chunk', { text });
      },
      onToolStart: (info) => {
        sessionLog.append('tool-start', info, PANE);
        send('agent:tool-start', info);
      },
      onToolEnd: (info) => {
        sessionLog.append('tool-end', info, PANE);
        send('agent:tool-end', info);
      },
    });

    sessionLog.append('agent-done', { truncated: !!truncated, reason }, PANE);
    send('agent:done', { truncated: !!truncated, reason });
  } catch (err) {
    sessionLog.append('agent-error', { message: err.message }, PANE);
    send('agent:error', { message: err.message });
  }
  // Pick up the lines we just appended (agent-in + agent-out chunks) so
  // search reflects the latest turn. The session log writes are async to
  // disk, so wait one tick before re-scanning the file.
  setImmediate(() => { runIngest(); });
});

// Hybrid search over indexed session logs. Routed through the worker
// host, so the main thread doesn't block on SQLite or embedding. Runs an
// incremental ingest before searching so freshly-written turns are
// searchable as soon as agent:done fires.
ipcMain.handle('memory:search', async (_e, body = {}) => {
  const { query, limit, kindFilter, minConfidence } = body;
  if (!query || typeof query !== 'string') return { hits: [], totalCandidates: 0, stats: null };
  await runIngest();
  const opts = { query, kindFilter: kindFilter || null };
  // Only pass limit when caller specified one — sessionIndex.search
  // falls back to its default of 10. Threshold-only queries (no
  // explicit limit) intentionally leave limit undefined so the
  // search returns all rows ≥ threshold. See docs/memory-search.md.
  if (typeof limit === 'number') opts.limit = limit;
  if (typeof minConfidence === 'number' && minConfidence > 0) {
    opts.minConfidence = minConfidence;
  }
  const hits = await indexHost.search(opts);
  // hits is an Array with a non-enumerable totalCandidates property —
  // pull it out explicitly so it survives the IPC JSON roundtrip.
  const totalCandidates = (hits && typeof hits.totalCandidates === 'number')
    ? hits.totalCandidates
    : hits.length;
  return { hits, totalCandidates, stats: await indexHost.stats() };
});

// Force a re-ingest. Useful from DevTools while iterating; not currently
// exposed in the UI.
ipcMain.handle('memory:ingest', async () => {
  await runIngest();
  return indexHost.stats();
});

// Write a freeform memory directly to the index. Mirrors the
// /memory/store HTTP route but stays in-process so the renderer test
// panel doesn't need to talk to the loopback server.
ipcMain.handle('memory:store', async (_e, body = {}) => {
  return indexHost.storeMemory(body);
});

// --- Agent registry IPC ---------------------------------------------------
// Same shape as the /agent/* HTTP routes, exposed in-process so the
// renderer test panel can drive register/list/send/inbox without going
// through HTTP. CLI users still hit the loopback server; the registry
// is the same object behind both paths.
ipcMain.handle('agent:register', async (_e, body = {}) => {
  try { return { ok: true, ...agentRegistry.register(body) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('agent:heartbeat', async (_e, body = {}) => {
  try { return { ok: true, ...agentRegistry.heartbeat(body) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('agent:send', async (_e, body = {}) => {
  try { return { ok: true, ...agentRegistry.send(body) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('agent:inbox', async (_e, body = {}) => {
  try { return { ok: true, messages: agentRegistry.inbox(body) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('agent:list', async () => {
  return { ok: true, agents: agentRegistry.list() };
});
ipcMain.handle('agent:unregister', async (_e, body = {}) => {
  return { ok: true, ...agentRegistry.unregister(body) };
});
ipcMain.handle('agent:rename', async (_e, body = {}) => {
  try { return { ok: true, ...agentRegistry.rename(body) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// --- Worker management ----------------------------------------------------
// Workers are headless agents (claude or shell) the chat drives. The
// previous "attach a PTY pane" UX is gone — workers are spawned
// directly through these IPC handlers.

ipcMain.handle('worker:spawn', async (_e, body = {}) => {
  try {
    const kind = body.kind === 'shell'    ? 'shell'
               : body.kind === 'semantic' ? 'semantic'
                                          : 'claude';
    const cwd = body.cwd || appSettings.get('lastCwd') || PROJECT_ROOT;
    let result;
    if (kind === 'shell') {
      result = await workerManager.spawnShell({ name: body.name, cwd });
    } else if (kind === 'semantic') {
      result = await workerManager.spawnSemantic({ name: body.name, cwd, device: body.device });
    } else {
      result = await workerManager.spawnWorker({
        name: body.name, cwd, permissionMode: body.permissionMode,
      });
    }
    // Remember this cwd as the new default for the next spawn.
    if (cwd) appSettings.set('lastCwd', cwd);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Native directory picker for choosing a worker's cwd. Defaults to
// the last-used cwd (or project root) so users land in a sensible
// place without scrolling.
ipcMain.handle('dialog:choose-directory', async (event, body = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const defaultPath = body.defaultPath || appSettings.get('lastCwd') || PROJECT_ROOT;
  const result = await dialog.showOpenDialog(win, {
    title: body.title || 'Choose worker directory',
    defaultPath,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const chosen = result.filePaths[0];
  return { canceled: false, path: chosen };
});

// Get/set persisted settings — currently just lastCwd, but the IPC
// is generic so future settings (theme, permission mode default)
// don't need new handlers.
ipcMain.handle('settings:get', (_e, { key, fallback } = {}) =>
  ({ value: appSettings.get(key, fallback) }));
ipcMain.handle('settings:set', (_e, { key, value } = {}) => {
  appSettings.set(key, value);
  return { ok: true };
});

ipcMain.handle('worker:list', () => ({ ok: true, workers: workerManager.list() }));

// Tool list for a single worker (semantic only today). Returns
// {ok:true, tools:[...]} or {ok:false, error} when the worker
// doesn't exist / has no toolkit. Renderer uses this to drive
// the slash-command autocomplete popup.
ipcMain.handle('worker:list-tools', (_e, body = {}) => {
  const tools = workerManager.listTools(body.id);
  if (!tools) return { ok: false, error: 'no toolkit for worker' };
  return { ok: true, tools };
});

// Embedder status from the bridge (real WebGPU detection — the
// hidden renderer probes navigator.gpu and reports back). Used by
// the renderer to populate the Device dropdown on the semantic-
// worker spawn UI honestly — if WebGPU isn't available we say so
// rather than silently falling back.
ipcMain.handle('models:embedder-status', async () => {
  try {
    const bridge = getEmbedderBridge();
    const status = await bridge.status();
    return { ok: true, ...status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('worker:send', (_e, body = {}) => {
  workerManager.send({ to: body.to, text: body.text });
  return { ok: true };
});

ipcMain.handle('worker:close', async (_e, { id } = {}) => {
  await workerManager.close(id);
  return { ok: true };
});

ipcMain.handle('worker:rename', (_e, body = {}) => {
  try { return { ok: true, ...workerManager.rename(body) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Memory-mirror controls.
ipcMain.handle('chat:get-settings', () => ({
  defaultMirror: workerManager.memoryMirrorDefault,
  workers: workerManager.list().map((w) => ({ id: w.id, memoryMirror: w.memoryMirror })),
}));
ipcMain.handle('chat:set-default-mirror', (_e, { on } = {}) => {
  workerManager.memoryMirrorDefault = !!on;
  return { ok: true, defaultMirror: workerManager.memoryMirrorDefault };
});
ipcMain.handle('chat:set-worker-mirror', (_e, { id, on } = {}) => {
  return { ok: true, ...workerManager.setMirror({ id, on: on === null ? null : !!on }) };
});

// Heartbeat every PTY-bound agent on a slow timer. They're alive as
// long as the PTY is alive; the registry's TTL eviction is for crashed
// (Heartbeat timer removed — workers no longer have a "bound" PTY
// concept. Drivers manage their own subprocess liveness.)

// ---- PTY ----
// Picks a sensible interactive shell on Windows.
function defaultWindowsShell() {
  // Prefer pwsh if installed; otherwise PowerShell 5; otherwise cmd.
  const candidates = [
    process.env.COMSPEC && /pwsh/i.test(process.env.COMSPEC) ? process.env.COMSPEC : null,
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : null,
    process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'powershell.exe';
}

function defaultShell() {
  // Test hook: MYAGENT_TEST_SHELL lets e2e tests run a deterministic
  // program (like fake-claude) directly as the PTY's "shell" — no
  // PowerShell in the way. Used only by tests/e2e/.
  if (process.env.MYAGENT_TEST_SHELL) return process.env.MYAGENT_TEST_SHELL;
  if (process.platform === 'win32') return defaultWindowsShell();
  return process.env.SHELL || '/bin/bash';
}

function defaultShellArgs() {
  if (process.env.MYAGENT_TEST_SHELL_ARGS) {
    return process.env.MYAGENT_TEST_SHELL_ARGS.split('|').filter(Boolean);
  }
  return [];
}

ipcMain.handle('pty:start', (event, { paneId, cwd, cols, rows } = {}) => {
  const pane = paneId || 'main';
  const key = ptyKey(event.sender.id, paneId);
  // Replace any existing PTY for this key (e.g., user typed /shell twice
  // in the same pane).
  const existing = ptys.get(key);
  if (existing) {
    try { existing.kill(); } catch { /* ignore */ }
    ptys.delete(key);
  }

  const shell = defaultShell();
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const ptyPath = `${BIN_DIR}${pathSep}${process.env.PATH || process.env.Path || ''}`;
  const term = pty.spawn(shell, defaultShellArgs(), {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: resolvedCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      PATH: ptyPath,
      // Windows-style env var name. Setting both avoids a "wrong case wins"
      // surprise on Windows where Path and PATH can both exist.
      Path: ptyPath,
      // Lets the shims find the discovery file without re-deriving
      // PROJECT_ROOT every invocation.
      MYAGENT_SESSIONS_DIR: SESSIONS_DIR,
    },
  });

  const rawLog = sessionLog.openRaw(pane);
  // Snapshot all of ~/.claude/projects/ so we can detect any `claude`
  // invocations that ran inside this PTY (regardless of which project dir
  // the user `cd`d into) and pull their model/token data.
  const claudeSnapshot = snapshotBefore(resolvedCwd);
  // On Windows ConPTY, term.pid is 0 immediately after spawn — the child
  // hasn't been created yet. Defer the pty-start log entry one tick so we
  // have a real pid to record.
  setImmediate(() => {
    sessionLog.append('pty-start', { shell, pid: term.pid, cwd: resolvedCwd, rawLog }, pane);
  });

  term.onData((data) => {
    sessionLog.rawOut(pane, data);
    sessionLog.ptyOut(pane, data);
    if (!event.sender.isDestroyed()) {
      event.sender.send('pty:data', { paneId: pane, data });
    }
  });
  term.onExit(({ exitCode, signal }) => {
    sessionLog.append('pty-exit', { exitCode, signal }, pane);
    sessionLog.closeRaw(pane);
    agentRegistry.dropWhere((a) => a.paneId === pane && a.webContentsId === event.sender.id);
    try {
      const summaries = summarizeWindow(claudeSnapshot, resolvedCwd);
      for (const s of summaries) {
        sessionLog.append('pty-agent-summary', s, pane);
      }
      if (summaries.length > 0) {
        // Refresh the markdown mirror for any project that had a `claude`
        // session in this window. Keeps Obsidian view current without
        // waiting for app shutdown.
        const grouped = groupSessionsByProject(summaries);
        mirrorAll({ outRoot: MEMORIES_DIR, sessionsByProject: grouped });
      }
    } catch { /* ignore: log correlation must not crash the app */ }
    ptys.delete(key);
    if (!event.sender.isDestroyed()) {
      event.sender.send('pty:exit', { paneId: pane, exitCode, signal });
    }
  });

  ptys.set(key, term);
  return { ok: true, shell, pid: term.pid };
});

ipcMain.on('pty:input', (event, { paneId, data } = {}) => {
  const term = ptys.get(ptyKey(event.sender.id, paneId));
  if (term && typeof data === 'string') {
    sessionLog.ptyIn(paneId || 'main', data);
    term.write(data);
  }
});

ipcMain.on('pty:resize', (event, { paneId, cols, rows } = {}) => {
  const term = ptys.get(ptyKey(event.sender.id, paneId));
  if (term && cols > 0 && rows > 0) {
    try { term.resize(cols, rows); } catch { /* ignore */ }
  }
});

ipcMain.on('pty:kill', (event, { paneId } = {}) => {
  const key = ptyKey(event.sender.id, paneId);
  const term = ptys.get(key);
  if (term) {
    try { term.kill(); } catch { /* ignore */ }
    ptys.delete(key);
  }
});

// Loopback search server. When the Electron app is running, the CLI shim
// (bin/memory-search.js) talks to this instead of loading its own copy of
// the embedding model — saves ~3s per CLI call when claude chains queries.
let searchServerStop = null;
async function startSearchServer() {
  if (searchServerStop) return;
  try {
    const handle = await sessionServer.start({
      sessionsDir: SESSIONS_DIR,
      // Server-side adapter — translates HTTP routes into worker host
      // calls. The host already serializes its own ops, so the server
      // can be as thin as possible.
      search: (opts) => indexHost.search(opts),
      stats: () => indexHost.stats(),
      ingest: () => runIngest(),
      storeMemory: (opts) => indexHost.storeMemory(opts),
      agents: agentRegistry,
    });
    searchServerStop = handle.stop;
  } catch {
    // Server failure shouldn't prevent the app from running. CLI will
    // fall back to standalone mode and pay the model-load cost itself.
    searchServerStop = null;
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  // Kick off the first ingest in the background. Window paints first,
  // model download (on first run) and SQLite open happen off the critical
  // path. Errors are swallowed inside runIngest.
  setImmediate(() => { runIngest(); });
  // Bind the search server too. Discovery file lands at
  // .myagent/sessions/server.json — the CLI looks for it.
  setImmediate(() => { startSearchServer(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Set to true after the deferred shutdown so we don't loop on the
// before-quit event when app.quit() resumes.
let shutdownDone = false;
app.on('before-quit', (ev) => {
  if (shutdownDone) return;
  ev.preventDefault();
  // Kill any live PTYs first so their onExit handlers run while the
  // session log + raw streams are still open. Without this, the PTYs
  // are torn down by the OS *after* sessionLog.close(), and the late
  // pty-exit / pty-agent-summary writes hit an ended stream ("write
  // after end") and the memory mirror they trigger never lands.
  for (const [key, term] of ptys) {
    try { term.kill(); } catch { /* ignore */ }
    ptys.delete(key);
  }
  // Give the PTY onExit handlers a moment to fire — they emit the final
  // pty-exit / pty-agent-summary lines and refresh the memory mirror
  // for sessions that were still running. 250ms is enough on Windows
  // ConPTY in practice without making quit feel laggy.
  setTimeout(async () => {
    try {
      // Final memory sweep — picks up any projects whose memory changed
      // outside of a captured PTY window.
      mirrorAll({ outRoot: MEMORIES_DIR, sessionsByProject: {} });
    } catch { /* ignore */ }
    try { sessionLog.close(); } catch { /* ignore */ }
    try { await workerManager.closeAll(); } catch { /* ignore */ }
    if (searchServerStop) {
      try { await searchServerStop(); } catch { /* ignore */ }
      searchServerStop = null;
    }
    try { await indexHost.close(); } catch { /* ignore */ }
    if (embedderBridge) {
      try { await embedderBridge.stop(); } catch { /* ignore */ }
      embedderBridge = null;
    }
    shutdownDone = true;
    app.quit();
  }, 250);
});
