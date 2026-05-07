// Electron main process. This file owns:
//   - shared state (workerManager, indexHost, agentRegistry, browserManager,
//     appSettings, sessionLog, embedder bridge, runner cache)
//   - lazy getters for heavy dependencies (embedder bridge, semantic factory,
//     ollama runner) so app startup stays fast
//   - the auto-context provider that prepends "Relevant past context" to
//     prompts before they reach a worker
//   - lifecycle (createWindow, application menu, app.whenReady / before-quit)
//
// IPC handlers live in electron/ipc/*. main.js wires them up at startup with
// register({...deps}) — each module closes over the deps it needs.

const { app, BrowserWindow, ipcMain, Menu, dialog, session } = require('electron');
const path = require('path');

const csp = require('./csp');

const { createRunner } = require('../src/core/runners');
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

const browserHandlers = require('./ipc/browser-handlers');
const agentHandlers = require('./ipc/agent-handlers');
const memoryHandlers = require('./ipc/memory-handlers');
const workerHandlers = require('./ipc/worker-handlers');
const modelHandlers = require('./ipc/model-handlers');
const ptyHandlers = require('./ipc/pty-handlers');

// ---- Paths -----------------------------------------------------------------

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

// ---- Shared state ----------------------------------------------------------

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

// One log file per app launch. Captures everything that hits the
// terminals (agent + every PTY pane). Lives in .myagent/ which is
// gitignored. See src/core/sessionLog.js.
const sessionLog = new SessionLog({ dir: SESSIONS_DIR });

// ---- Auto-context provider -------------------------------------------------
// Before each user prompt is sent to a worker, search memory for relevant
// past context and prepend it as a "Relevant past context" preamble.
// Silent — the worker sees an augmented prompt, but the chat:user event the
// UI displays is the original text. Failure here is non-fatal (provider
// returns empty).
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

// ---- Lazy heavy dependencies -----------------------------------------------

// Embedder bridge — talks to the model Worker hosted by the chat
// renderer (so it can target WebGPU; main is Node and can't). The
// semantic factory closes over this bridge so all semantic workers
// share one model load (and one Worker).
let embedderBridge = null;
function getEmbedderBridge() {
  if (embedderBridge) return embedderBridge;
  embedderBridge = createEmbedderBridge({
    getWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  });
  // Begin waiting for the renderer's `model:ready` IPC. start() is
  // resolved by that signal; the WebGPU probe completes before the
  // user clicks "+ Spawn Semantic worker" so the device dropdown
  // reflects truth.
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
    // The semantic worker only does routing now — pure embed-based
    // tool selection. No generator, no per-spawn device. The model
    // service (renderer/workers/model-worker.js) picks its own device.
    embedder: { embed: (text) => bridge.embed(text) },
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

// ---- Window + menu ---------------------------------------------------------

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

// Track the main window so the embedder bridge can target its
// webContents when the SemanticDriver requests an embed/generate.
// The bridge needs the same renderer that hosts the model Worker.
let mainWindow = null;

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
  mainWindow = win;
  // In dev (npm run dev), Vite serves the renderer at this URL; in prod,
  // load the built bundle from renderer/dist/. VITE_DEV_SERVER_URL is set
  // by the dev script in package.json — its absence is the prod signal.
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(PROJECT_ROOT, 'renderer', 'dist', 'index.html'));
  }

  win.webContents.on('destroyed', () => {
    const id = win.webContents.id;
    ptyHandlers.killForWebContents(id);
    agentRegistry.dropWhere((a) => a.webContentsId === id);
    browserManager.destroyAllForWindow(win);
    if (mainWindow === win) mainWindow = null;
  });
}

// ---- Loopback search server ------------------------------------------------
// When the Electron app is running, the CLI shim (bin/memory-search.js) talks
// to this instead of loading its own copy of the embedding model — saves ~3s
// per CLI call when claude chains queries.

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

// ---- IPC wiring ------------------------------------------------------------

function registerIpcHandlers() {
  browserHandlers.register({ ipcMain, BrowserWindow, browserManager });
  agentHandlers.register({
    ipcMain, getRunner, agentRegistry, sessionLog,
    outputDir: OUTPUT_DIR, runIngest,
  });
  memoryHandlers.register({ ipcMain, indexHost, runIngest });
  workerHandlers.register({
    ipcMain, BrowserWindow, dialog, workerManager, appSettings,
    projectRoot: PROJECT_ROOT,
  });
  modelHandlers.register({ ipcMain, getEmbedderBridge });
  ptyHandlers.register({
    ipcMain, sessionLog, agentRegistry,
    binDir: BIN_DIR, sessionsDir: SESSIONS_DIR, memoriesDir: MEMORIES_DIR,
    snapshotBefore, summarizeWindow, mirrorAll, groupSessionsByProject,
  });
}

// ---- App lifecycle ---------------------------------------------------------

app.whenReady().then(() => {
  buildMenu();
  // Install CSP headers on the default session before any window loads.
  // Dev URL — when set — loosens CSP enough for Vite HMR; prod is strict.
  csp.apply({
    session: session.defaultSession,
    devServerUrl: process.env.VITE_DEV_SERVER_URL || null,
  });
  registerIpcHandlers();
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
  ptyHandlers.killAll();
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
