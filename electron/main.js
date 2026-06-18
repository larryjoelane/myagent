// Electron main process. This file owns:
//   - shared state (workerManager, indexHost, agentRegistry, browserManager,
//     appSettings, sessionLog, embedder bridge, runner cache)
//   - lazy getters for heavy dependencies (embedder bridge, ollama runner)
//     so app startup stays fast
//   - the auto-context provider that prepends "Relevant past context" to
//     prompts before they reach a worker
//   - lifecycle (createWindow, application menu, app.whenReady / before-quit)
//
// IPC handlers live in electron/ipc/*. main.js wires them up at startup with
// register({...deps}) — each module closes over the deps it needs.

const path = require('path');
const os = require('os');
// Load .env from the project root before any module reads process.env.
// Keeps secrets like OLLAMA_API_KEY out of settings.json by design.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { app, BrowserWindow, ipcMain, Menu, dialog, session, shell } = require('electron');

const csp = require('./csp');

const { SessionLog } = require('../src/core/sessionLog');
const { snapshotBefore, summarizeWindow } = require('../src/core/claudeSessionScan');
const { mirrorAll, groupSessionsByProject } = require('../src/core/memoryMirror');
const {
  resolveMinConfidence, DEFAULT_MIN_CONFIDENCE,
  resolveSpreadStrength, DEFAULT_SPREAD_STRENGTH,
} = require('../src/core/autoContextConfig');
const sessionServer = require('../src/core/sessionServer');
const { WorkerHost } = require('../src/core/sessionWorkerHost');
const { createAgentRegistry } = require('../src/core/agentRegistry');
const { WorkerManager } = require('../src/core/workerManager');
const { Scope } = require('../src/core/scope');
const { ShellDriver } = require('../src/core/drivers/shellDriver');
const { LocalModelDriver } = require('../src/core/drivers/localModelDriver');
const {
  OpenAICompatibleDriver,
  OPENROUTER_PROVIDER,
} = require('../src/core/drivers/openAICompatibleDriver');
const { OllamaRunner } = require('../src/core/runners/ollama');
const { OpenRouterRunner } = require('../src/core/runners/openrouter');
const {
  createOllamaPreset,
  createOpenRouterPreset,
  buildRegistryWithSkills,
} = require('../src/core/llm');
const { loadSkills } = require('../src/core/skills');
const { createHookProvider } = require('../src/core/hooks');
const { AppSettings } = require('../src/core/appSettings');
const { BrowserManager } = require('../src/core/browserManager');
const { TokenLedger, normalizeUsage } = require('../src/core/tokenLedger');
const { createEmbedderBridge } = require('../src/core/embedderBridge');

const browserHandlers = require('./ipc/browser-handlers');
const agentHandlers = require('./ipc/agent-handlers');
const memoryHandlers = require('./ipc/memory-handlers');
const workerHandlers = require('./ipc/worker-handlers');
const fsHandlers = require('./ipc/fs-handlers');
const editorHandlers = require('./ipc/editor-handlers');
const modelHandlers = require('./ipc/model-handlers');
const ptyHandlers = require('./ipc/pty-handlers');
const tokenHandlers = require('./ipc/token-handlers');
const { EditorWindowManager } = require('./editorWindow');

// ---- Paths -----------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'project-output');

function resolveSessionsDir() {
  const defaultDir = path.join(PROJECT_ROOT, '.myagent', 'sessions');
  const raw = String(process.env.MYAGENT_SESSIONS_DIR || '').trim();
  if (!raw) return defaultDir;

  const candidate = path.resolve(raw);
  const trustedBases = [
    path.resolve(PROJECT_ROOT),
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
  ];

  for (const base of trustedBases) {
    if (candidate === base || candidate.startsWith(base + path.sep)) return candidate;
  }
  return defaultDir;
}

// Honor MYAGENT_SESSIONS_DIR for tests + advanced users — overrides
// the default per-repo sessions directory. When set, ALL state
// (memory index, app settings, session logs) lives there.
const SESSIONS_DIR = resolveSessionsDir();
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

// Convert a freeform memory note ({ text, source, tags }) into a
// MySecondBrain turn: the note text is the `answer`, and `prompt` records
// the note's provenance (what caused it) so it's tied to its trigger and
// distinguishable from a real Q+A pair.
function noteToTurn(body = {}) {
  const text = String(body.text || '').trim();
  const source = body.source ? String(body.source).trim() : '';
  const tags = Array.isArray(body.tags) ? body.tags.filter(Boolean) : [];
  const parts = ['saved note'];
  if (source) parts.push(`source: ${source}`);
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`);
  return { prompt: `[${parts.join(' · ')}]`, answer: text, provider: 'note', ts: body.ts || undefined };
}

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
  persistChatEvent(event, payload);
  recordTokens(event, payload);
}

// Pull token usage off chat:turn-end events and feed it to the ledger.
// Drivers stamp `provider` on the payload; `totals` is whatever shape
// they already produce (Ollama: promptEvalCount/evalCount; OpenAI:
// usage.{prompt,completion}_tokens; Claude: usage.{input,output}_tokens).
// normalizeUsage handles all three.
function recordTokens(event, payload) {
  if (event !== 'chat:turn-end' || !payload) return;
  const provider = payload.provider;
  const totals = payload.totals;
  const agentId = payload.agentId;
  if (!provider || !totals || !agentId) return;
  const model = totals.model || '';
  if (!model) return;
  const { inputTokens, outputTokens } = normalizeUsage(totals);
  if (inputTokens === 0 && outputTokens === 0) return;
  tokenLedger.record({ provider, model, agentId, inputTokens, outputTokens });
}

// Persist a subset of chat:* events to the session log so post-mortems
// don't depend on user memory. We skip chat:chunk (would balloon the
// log with token-by-token deltas) and the very low-signal events. The
// surviving set is what you'd want to read when a turn went wrong:
//   - chat:user       what the user typed
//   - chat:tool-call  what tool the model invoked, with arguments
//   - chat:tool-result outcome (ok/error + content)
//   - chat:turn-end   final assistantText, iterations, totals, ok
//   - chat:error      anything the driver bailed on
const PERSISTED_CHAT_EVENTS = new Set([
  'chat:user',
  'chat:tool-call',
  'chat:tool-result',
  'chat:turn-end',
  'chat:error',
  'chat:env-context',
]);
function persistChatEvent(event, payload) {
  if (!PERSISTED_CHAT_EVENTS.has(event)) return;
  if (!sessionLog) return;
  try {
    sessionLog.append(event, payload || {}, 'main');
  } catch { /* logging must never crash the app */ }
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

// Cross-restart token tally per worker / model / provider. Lives in
// the sessions dir so it shares the lifetime of the project. Drivers
// emit chat:turn-end with provider + totals; broadcastChat() below
// records into the ledger. The ledger fans subscribe() callbacks for
// the IPC layer to push tokens:update events to renderers.
const tokenLedger = new TokenLedger({
  persistPath: path.join(SESSIONS_DIR, 'token-ledger.json'),
});

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
  // User-adjustable via the settings drawer ("Memory match threshold").
  // Clamping + default live in src/core/autoContextConfig.js.
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  maxHits: 3,            // top-k injected
  maxChars: 1500,        // hard cap on preamble size (~500 tokens)
};

async function memoryContextProvider({ text }) {
  if (!appSettings.get('autoContext', true)) return { preamble: '', usedHits: [] };
  if (!text || !text.trim()) return { preamble: '', usedHits: [] };
  try {
    const hits = await indexHost.searchTurns({
      query: text,
      limit: AUTO_CONTEXT_DEFAULTS.maxHits,
      minConfidence: resolveMinConfidence(
        appSettings.get('autoContextMinConfidence', DEFAULT_MIN_CONFIDENCE),
      ),
      // "Spread strength" — how strongly associatively-wired memories are
      // boosted in the synapse ranking. User-adjustable via the settings drawer.
      spreadFactor: resolveSpreadStrength(
        appSettings.get('autoContextSpreadStrength', DEFAULT_SPREAD_STRENGTH),
      ),
    });
    if (!hits || hits.length === 0) return { preamble: '', usedHits: [] };
    // searchTurns already orders hits by synapse score (relevance + associative
    // spread, modulated by energy) descending — highest first. We surface that
    // score AND the energy (recency×frequency) on each line so the model can
    // weight stronger/hotter memories. Trim each body and stop adding once we
    // hit the char cap so the preamble can't blow up the context window.
    const lines = ['[Relevant past context — ordered by synapse score (strongest first); use if helpful]'];
    const used = [];
    let total = lines[0].length;
    for (const h of hits) {
      const body = (h.text || h.snippet || '').trim();
      if (!body) continue;
      const trimmed = body.length > 500 ? body.slice(0, 500) + '…' : body;
      const score = Number.isFinite(h.score) ? h.score.toFixed(2) : '—';
      const energy = Number.isFinite(h.energy) ? h.energy.toFixed(2) : '—';
      const line = `- [score ${score} · energy ${energy}] ${trimmed}`;
      if (total + line.length + 1 > AUTO_CONTEXT_DEFAULTS.maxChars) break;
      lines.push(line);
      total += line.length + 1;
      used.push({
        id: h.id,
        confidence: h.confidence,
        score: h.score,
        energy: h.energy,
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

// File-context provider: prepend the editor's active tab as a "[Active
// editor]" preamble for chat workers. Per the Phase 5 plan, this fires
// for claude + ollama-cloud only — shell and slash-command prompts
// already bypass auto-context wholesale (see WorkerManager).
//
// Hard cap on file size so the preamble doesn't dominate the context
// window. If the active buffer is larger than the cap we send a head
// + tail slice with a "<truncated>" marker so the model still has
// useful structural cues.
const FILE_CONTEXT_MAX_CHARS = 12000;

function fileContextProvider() {
  if (!appSettings.get('autoFileContext', true)) {
    return { preamble: '', fileSource: null };
  }
  const tab = editorWindow.getActiveTab();
  if (!tab || !tab.path) return { preamble: '', fileSource: null };
  const lang = languageHintForPath(tab.path);
  const dirtyTag = tab.dirty ? ' (unsaved buffer)' : '';
  const header = `[Active editor: ${tab.path}${dirtyTag}]`;
  let body = tab.content || '';
  if (body.length > FILE_CONTEXT_MAX_CHARS) {
    const head = body.slice(0, FILE_CONTEXT_MAX_CHARS / 2);
    const tail = body.slice(body.length - FILE_CONTEXT_MAX_CHARS / 2);
    body = head + '\n\n<…file truncated for context…>\n\n' + tail;
  }
  const fenceLang = lang || '';
  const preamble = `${header}\n\`\`\`${fenceLang}\n${body}\n\`\`\`\n\n`;
  return {
    preamble,
    fileSource: { path: tab.path, dirty: !!tab.dirty },
  };
}

function languageHintForPath(p) {
  const m = String(p || '').toLowerCase().match(/\.([^.\\/]+)$/);
  if (!m) return '';
  const ext = m[1];
  const map = {
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
    go: 'go', cs: 'csharp', sh: 'bash', bash: 'bash',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
    html: 'html', css: 'css', sql: 'sql', toml: 'toml',
  };
  return map[ext] || '';
}

// Composed provider: the WorkerManager calls a single contextProvider.
// We run memory + file lookups in parallel, then concatenate the
// preambles. usedHits keeps memory-only shape (renderer expects it);
// fileSource is a sibling field the chat-log uses to render a file
// badge alongside (or instead of) the memories badge.
async function autoContextProvider(opts) {
  const [memory, file] = await Promise.all([
    memoryContextProvider(opts).catch(() => ({ preamble: '', usedHits: [] })),
    Promise.resolve().then(() => fileContextProvider()).catch(() => ({ preamble: '', fileSource: null })),
  ]);
  const preamble = (file.preamble || '') + (memory.preamble || '');
  return {
    preamble,
    usedHits: memory.usedHits || [],
    fileSource: file.fileSource || null,
  };
}

// ---- Lazy heavy dependencies -----------------------------------------------

// Embedder bridge — talks to the model Worker hosted by the chat
// renderer (so it can target WebGPU; main is Node and can't). Used by the
// model-settings IPC handlers (device status / cache / warmup) and any
// embedding-backed feature; built lazily on first use.
let embedderBridge = null;
function getEmbedderBridge() {
  if (embedderBridge) return embedderBridge;
  embedderBridge = createEmbedderBridge({
    getWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  });
  // Begin waiting for the renderer's `model:ready` IPC. start() is
  // resolved by that signal; the WebGPU probe completes so the model
  // settings device dropdown reflects truth.
  embedderBridge.start().catch((err) => {
    // Non-fatal: log so we at least see a bridge start failure.
    // eslint-disable-next-line no-console
    console.error('[embedder bridge] start failed:', err);
  });
  return embedderBridge;
}

// ---- Editor scope ----------------------------------------------------------
// The editor's file-tree, viewer, and save flow are bounded by a single
// global Scope (per ADR-0008). Initial root prefers the persisted
// editorRoot (set via the file-tree's "change root" button) so worker
// spawns that update lastCwd don't drag the tree along; falls back to
// lastCwd, then PROJECT_ROOT. Users grow the scope at runtime via
// fs:scope-add / fs:scope-remove IPC.
//
// Defined BEFORE workerManager because the manager's per-worker
// scopes seed themselves from this object's roots at spawn time.
const editorScope = new Scope([
  appSettings.get('editorRoot') || appSettings.get('lastCwd') || PROJECT_ROOT,
]);

// WorkerManager owns spawn/list/send/close for chat-driven agents and
// shells. It hands forwarded events to broadcastChat so any open
// AgentManager renderer sees them. Memory mirror lives inside the
// manager — pass indexHost as the storage backend. The
// contextProvider wires auto-context retrieval into the send path.
// Shared construction for OpenAI-compatible workers (ollama-cloud,
// openrouter). Discovers skills at spawn-time so changes under
// .myagent/skills/ or .claude/skills/ pick up on every fresh worker
// without an app restart (each skill becomes a `skill_<name>` tool;
// see defaultSkillRoots() for the order), then wires the registry,
// memory backend, env context, and skill scope guard the same way for
// both providers. `cfg` carries the only differences: provider label,
// providerConfig (env-var names + defaults), and the runner/preset
// factories.
function buildOpenAICompatibleWorker(opts, cfg) {
  const workerCwd = opts.cwd || PROJECT_ROOT;
  const skills = loadSkills({ cwd: workerCwd });
  if (skills.length > 0 && !process.env.MYAGENT_QUIET) {
    // eslint-disable-next-line no-console
    console.error(`[${cfg.label}] loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(', ')}`);
  }
  // Hooks: guardrails for two phases — pre-LLM-send and pre-tool-dispatch.
  // The provider ALWAYS includes the built-in guardrails (e.g. no-secrets)
  // regardless of cwd, then adds any DISCOVERED hooks (.myagent/hooks,
  // .claude/hooks, ~/.claude/hooks). So every worker is gated even when the
  // open directory has no hook folder — the bug this fixes was a worker in
  // such a directory writing a secret with nothing to stop it. Resolution is
  // also cwd-AWARE: discovered hooks re-resolve against the worker's CURRENT
  // cwd before each gate (memoized), so a mid-run directory switch picks up
  // the new tree's hooks. A discovered hook overrides a built-in of the same
  // name (project beats built-in).
  const hooksProvider = createHookProvider({ fallbackCwd: workerCwd });
  // Log the spawn-cwd hook set once for visibility (the provider memoizes
  // this scan, so it's not redundant work).
  if (!process.env.MYAGENT_QUIET) {
    const spawnHooks = hooksProvider(workerCwd);
    if (spawnHooks.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[${cfg.label}] loaded ${spawnHooks.length} hook(s): ${spawnHooks.map((h) => h.name).join(', ')}`);
    }
  }
  return new OpenAICompatibleDriver({
    ...opts,
    providerConfig: cfg.providerConfig, // undefined => ollama-cloud default
    runnerFactory: cfg.runnerFactory,
    presetFactory: cfg.presetFactory,
    toolRegistry: buildRegistryWithSkills({ skills }),
    tools: true,
    cwd: workerCwd,
    hooksProvider,
    // Skill metadata for slash invocation (/skill <name>, /<name>): the
    // driver needs each skill's dir for the scope guard + bash cwd pin,
    // which the registry doesn't carry. skillScopeGuard defaults on in
    // the driver; opts.skillScopeGuard (undefined today) lets a future
    // per-worker UI toggle flow through _spawn without re-touching this.
    skills,
    skillScopeGuard: opts.skillScopeGuard,
    // Default env context: the built-in builder (cwd/platform/git/scope/
    // date). Per-spawn opts.envContext overrides; `false` disables it.
    envContext: opts.envContext === undefined ? true : opts.envContext,
    // Wire the session index so memory_search / memory_store work when the
    // model invokes them. Both go through MySecondBrain (the unified store):
    // search uses searchTurns; a stored note becomes a turn whose `answer` is
    // the note and whose `prompt` records its provenance.
    memory: {
      search: (opts2) => indexHost.searchTurns(opts2),
      store: (body) => indexHost.storeTurn(noteToTurn(body)),
    },
  });
}

// Build a local-model worker (LocalModelDriver). Generates via the in-process
// model worker (bridge.generate) and dispatches parsed text commands through
// the same tool registry + cwd-aware hooks the cloud workers use.
function buildLocalWorker(opts) {
  const workerCwd = opts.cwd || PROJECT_ROOT;
  const skills = loadSkills({ cwd: workerCwd });
  const hooksProvider = createHookProvider({ fallbackCwd: workerCwd });
  const bridge = getEmbedderBridge();
  return new LocalModelDriver({
    ...opts,
    cwd: workerCwd,
    model: opts.model,
    // Stream tokens so the user sees output as it generates (a 0.5B CPU model
    // is ~2 tok/s — a non-streaming call would block silently for minutes).
    // onToken is invoked per token with { token, cumulativeText, index }.
    generate: (prompt, genOpts, onToken) =>
      bridge.generateStream(prompt, genOpts, onToken),
    toolRegistry: buildRegistryWithSkills({ skills }),
    hooksProvider,
  });
}

const workerManager = new WorkerManager({
  factories: {
    shell:  (opts) => new ShellDriver({ ...opts, cwd: opts.cwd || PROJECT_ROOT }),
    // Hosted Ollama Cloud. Reads OLLAMA_API_KEY / OLLAMA_MODEL /
    // OLLAMA_HOST from process.env (loaded via dotenv at the top of
    // this file). The driver itself surfaces a clean error if the key
    // is missing, so we don't gate the factory on it here.
    // Ollama Cloud with tool-use enabled: the driver routes through
    // ToolUseLoop using the OpenAI-format preset and the default tool
    // registry (echo / read_file / write_file). Per-worker scope from
    // _spawn flows in via opts.scope and gates fs-touching tools.
    // runnerFactory stays wired so the plain-chat path still works as
    // a fallback when tools are intentionally disabled.
    // ollama-cloud and openrouter are the same OpenAICompatibleDriver with
    // different provider config + preset/runner. buildOpenAICompatibleWorker
    // captures the shared wiring (skill discovery, registry, memory, env
    // context) so the two factory entries stay one-liners.
    'ollama-cloud': (opts) => buildOpenAICompatibleWorker(opts, {
      label: 'ollama-cloud',
      runnerFactory: (runnerOpts) => new OllamaRunner(runnerOpts),
      presetFactory: (presetOpts) => createOllamaPreset(presetOpts),
    }),
    openrouter: (opts) => buildOpenAICompatibleWorker(opts, {
      label: 'openrouter',
      providerConfig: OPENROUTER_PROVIDER,
      runnerFactory: (runnerOpts) => new OpenRouterRunner(runnerOpts),
      presetFactory: (presetOpts) => createOpenRouterPreset(presetOpts),
    }),
    // Local in-process text model (ONNX via the model worker). Drives tools by
    // parsed text commands instead of JSON tool-calling — for no/low-GPU
    // users. Reuses the same tool registry + cwd-aware hooks as the cloud
    // workers, so the no-secrets guardrail + per-worker scope still apply.
    local: (opts) => buildLocalWorker(opts),
  },
  onEvent: (name, payload) => broadcastChat(name, payload),
  // Chat turns mirror to MySecondBrain (one row per Q+A pair). `store` is
  // kept for any legacy single-text callers; the mirror uses storeTurn.
  memoryStore: {
    store: (body) => indexHost.storeMemory(body),
    storeTurn: (turn) => indexHost.storeTurn(turn),
  },
  memoryMirrorDefault: true,
  contextProvider: autoContextProvider,
  // Per-worker scopes (ADR-0008). Each spawn snapshots the editor
  // scope's current roots into its own per-worker Scope, so a worker
  // sees the editor roots that existed at spawn time AND its cwd.
  // Mutations after spawn go through worker:add-scope/remove-scope.
  editorScope,
});

// Editor BrowserWindow — lazy. No window is created until the user
// clicks a file in the tree (which sends editor:open-file).
const editorWindow = new EditorWindowManager({
  preloadPath: path.join(__dirname, 'preload.js'),
  projectRoot: PROJECT_ROOT,
  devServerUrl: process.env.VITE_DEV_SERVER_URL || null,
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
// When the Electron app is running, the CLI shim (.claude/skills/recall/recall.js) talks
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
      // Unified store: search + freeform store go through MySecondBrain.
      search: (opts) => indexHost.searchTurns(opts),
      stats: () => indexHost.stats(),
      ingest: () => runIngest(),
      storeMemory: (opts) => indexHost.storeTurn(noteToTurn(opts)),
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
  agentHandlers.register({ ipcMain, agentRegistry });
  memoryHandlers.register({ ipcMain, indexHost, runIngest });
  workerHandlers.register({
    ipcMain, BrowserWindow, dialog, workerManager, appSettings,
    projectRoot: PROJECT_ROOT,
  });
  fsHandlers.register({ ipcMain, scope: editorScope, shell });
  editorHandlers.register({ ipcMain, editorWindow, scope: editorScope, appSettings });
  modelHandlers.register({ ipcMain, getEmbedderBridge });
  ptyHandlers.register({
    ipcMain, sessionLog, agentRegistry,
    sessionsDir: SESSIONS_DIR, memoriesDir: MEMORIES_DIR,
    snapshotBefore, summarizeWindow, mirrorAll, groupSessionsByProject,
  });
  tokenHandlers.register({
    ipcMain, tokenLedger,
    broadcast: (event, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(event, payload);
      }
    },
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
    try { tokenLedger.close(); } catch { /* ignore */ }
    try { editorWindow.destroy(); } catch { /* ignore */ }
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
