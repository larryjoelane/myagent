// Preload script. Bridges the renderer (sandboxed, no Node) to the
// main process (Electron main, full Node) over IPC.
//
// Layout: pure functions for each piece of the bridge, then a thin
// installer at the bottom that wires them up using the real
// `electron` runtime. Tests import the pure functions directly with
// fake `ipcRenderer` / `contextBridge` and assert event forwarding
// + transport-method coverage. This catches the failure mode where
// main emits a new event but the preload forgets to forward it —
// silent in production until a user reports the symptom.
//
// IMPORTANT: Electron's preload runs under a sandbox that uses its
// own restricted `preloadRequire`. It cannot resolve relative
// requires the way Node does — `require('./preload-events')` throws
// "module not found" inside the sandbox even though it works fine
// in tests and plain Node. So we INLINE the canonical channel list
// here. The matching list in tests/preload.test.js is asserted to
// match this one; if you add a channel here, also add it there
// (the bridge tests will fail otherwise).
const ALL_FORWARDED_CHANNELS = [
  // Worker channel events — every chat-driven driver. The renderer
  // subscribes via transport.chat.on(...).
  { channel: 'chat:user',          emitAs: 'chat:user' },
  { channel: 'chat:turn-start',    emitAs: 'chat:turn-start' },
  { channel: 'chat:chunk',         emitAs: 'chat:chunk' },
  { channel: 'chat:turn-end',      emitAs: 'chat:turn-end' },
  { channel: 'chat:context-used',  emitAs: 'chat:context-used' },
  { channel: 'chat:tool-call',     emitAs: 'chat:tool-call' },
  { channel: 'chat:tool-result',   emitAs: 'chat:tool-result' },
  { channel: 'chat:error',         emitAs: 'chat:error' },
  { channel: 'chat:driver-exit',   emitAs: 'chat:driver-exit' },
  { channel: 'chat:env-context',   emitAs: 'chat:env-context' },
  // Legacy agent-handler events. Renderer maps to short names for
  // backward compat.
  { channel: 'agent:chunk',        emitAs: 'chunk' },
  { channel: 'agent:done',         emitAs: 'done' },
  { channel: 'agent:error',        emitAs: 'error' },
  { channel: 'agent:tool-start',   emitAs: 'tool-start' },
  { channel: 'agent:tool-end',     emitAs: 'tool-end' },
  // PTY data/exit. Each carries { paneId, ... }; subscriber filters.
  { channel: 'pty:data',           emitAs: 'pty:data' },
  { channel: 'pty:exit',           emitAs: 'pty:exit' },
  // BrowserView events. Each carries { tabId, ... }; subscriber filters.
  { channel: 'browser:nav',        emitAs: 'browser:nav' },
  { channel: 'browser:title',      emitAs: 'browser:title' },
  { channel: 'browser:loading',    emitAs: 'browser:loading' },
  { channel: 'browser:error',      emitAs: 'browser:error' },
  // Generation streams + model-host requests.
  { channel: 'models:generate-chunk', emitAs: 'models:generate-chunk' },
  { channel: 'model:request',         emitAs: 'model:request' },
  // Editor BrowserWindow: main pushes a file to load via this channel.
  // Subscribed by transport.editor.onLoadFile in the editor renderer.
  { channel: 'editor:load-file',      emitAs: 'editor:load-file' },
  // Token ledger push: full snapshot on every record/forget/reset.
  // Subscribed by transport.tokens.onUpdate (worker-chips + future
  // analytics panel).
  { channel: 'tokens:update',         emitAs: 'tokens:update' },
];

/**
 * Install ipcRenderer listeners that re-emit incoming events through
 * the local listener registry. Pure: no side effects beyond the
 * provided `ipcRenderer.on` calls.
 *
 * @param {object} opts
 * @param {{ on: (channel: string, fn: (e: any, msg: any) => void) => void }} opts.ipcRenderer
 * @param {Map<string, Set<(msg: any) => void>>} opts.listeners - subscriber registry, mutated by transport.on
 * @param {Array<{channel: string, emitAs: string}>} [opts.channels] - defaults to ALL_FORWARDED_CHANNELS
 */
function installEventForwarders({ ipcRenderer, listeners, channels = ALL_FORWARDED_CHANNELS }) {
  for (const { channel, emitAs } of channels) {
    ipcRenderer.on(channel, (_e, msg) => emit(listeners, emitAs, msg));
  }
}

function emit(listeners, event, msg) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(msg);
}

/**
 * Build the `transport` object the renderer sees on
 * window.transport. Pure: takes the IPC + clipboard + listener
 * registry as deps, returns the object. The real installer calls
 * contextBridge.exposeInMainWorld with the result.
 *
 * @param {object} opts
 * @param {any} opts.ipcRenderer
 * @param {{ readText: () => string, writeText: (s: string) => void }} opts.clipboard
 * @param {Map<string, Set<(msg: any) => void>>} opts.listeners
 */
function buildTransport({ ipcRenderer, clipboard, listeners }) {
  const subscribe = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    /** @type {Set<any>} */ (listeners.get(event)).add(fn);
    return () => /** @type {Set<any>} */ (listeners.get(event))?.delete(fn);
  };

  return {
    kind: 'electron',
    on: subscribe,
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    },
    memory: {
      search: (query, opts) => ipcRenderer.invoke('memory:search', { query, ...(opts || {}) }),
      ingest: () => ipcRenderer.invoke('memory:ingest'),
      store: (body) => ipcRenderer.invoke('memory:store', body || {}),
    },
    workers: {
      spawn: (body) => ipcRenderer.invoke('worker:spawn', body || {}),
      list: () => ipcRenderer.invoke('worker:list'),
      send: (body) => ipcRenderer.invoke('worker:send', body || {}),
      cancel: (body) => ipcRenderer.invoke('worker:cancel', body || {}),
      close: (body) => ipcRenderer.invoke('worker:close', body || {}),
      rename: (body) => ipcRenderer.invoke('worker:rename', body || {}),
      listTools: (id) => ipcRenderer.invoke('worker:list-tools', { id }),
      ollamaCloudModels: () => ipcRenderer.invoke('worker:ollama-cloud-models'),
      openrouterModels: () => ipcRenderer.invoke('worker:openrouter-models'),
      listScope: (id) => ipcRenderer.invoke('worker:list-scope', { id }),
      addScope: (id, path) => ipcRenderer.invoke('worker:add-scope', { id, path }),
      removeScope: (id, path) => ipcRenderer.invoke('worker:remove-scope', { id, path }),
    },
    models: {
      embedderStatus: () => ipcRenderer.invoke('models:embedder-status'),
      embedderDevTools: () => ipcRenderer.invoke('models:embedder-devtools'),
      embedderBenchmark: (body) => ipcRenderer.invoke('models:embedder-benchmark', body || {}),
      list: (kind) => ipcRenderer.invoke('models:list', { kind }),
      cacheStatus: (modelId) => ipcRenderer.invoke('models:cache-status', { modelId }),
      warmup: (modelId, device) => ipcRenderer.invoke('models:warmup', { modelId, device }),
      generate: (body) => ipcRenderer.invoke('models:generate', body || {}),
      onGenerateChunk: (fn) => subscribe('models:generate-chunk', fn),
    },
    fs: {
      listDir: (path, opts) => ipcRenderer.invoke('fs:list-dir', { path, ...(opts || {}) }),
      readFile: (path) => ipcRenderer.invoke('fs:read-file', { path }),
      writeFile: (path, content, opts) =>
        ipcRenderer.invoke('fs:write-file', { path, content, ...(opts || {}) }),
      stat: (path) => ipcRenderer.invoke('fs:stat', { path }),
      scopeList: () => ipcRenderer.invoke('fs:scope-list'),
      scopeAdd: (path) => ipcRenderer.invoke('fs:scope-add', { path }),
      scopeRemove: (path) => ipcRenderer.invoke('fs:scope-remove', { path }),
    },
    dialog: {
      chooseDirectory: (opts) => ipcRenderer.invoke('dialog:choose-directory', opts || {}),
      saveFile: (opts) => ipcRenderer.invoke('dialog:save-file', opts || {}),
    },
    settings: {
      get: (key, fallback) => ipcRenderer.invoke('settings:get', { key, fallback }),
      set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
    },
    agents: {
      register: (body) => ipcRenderer.invoke('agent:register', body || {}),
      heartbeat: (body) => ipcRenderer.invoke('agent:heartbeat', body || {}),
      send: (body) => ipcRenderer.invoke('agent:send', body || {}),
      inbox: (body) => ipcRenderer.invoke('agent:inbox', body || {}),
      list: () => ipcRenderer.invoke('agent:list'),
      unregister: (body) => ipcRenderer.invoke('agent:unregister', body || {}),
      rename: (body) => ipcRenderer.invoke('agent:rename', body || {}),
    },
    chat: {
      getSettings: () => ipcRenderer.invoke('chat:get-settings'),
      setDefaultMirror: (on) => ipcRenderer.invoke('chat:set-default-mirror', { on }),
      setWorkerMirror: (id, on) => ipcRenderer.invoke('chat:set-worker-mirror', { id, on }),
      on: subscribe,
    },
    tokens: {
      snapshot: () => ipcRenderer.invoke('tokens:snapshot'),
      byWorker: (id) => ipcRenderer.invoke('tokens:by-worker', { id }),
      reset: () => ipcRenderer.invoke('tokens:reset'),
      onUpdate: (fn) => subscribe('tokens:update', fn),
    },
    browser: {
      create: (body) => ipcRenderer.invoke('browser:create', body || {}),
      destroy: (tabId) => ipcRenderer.invoke('browser:destroy', { tabId }),
      setBounds: (tabId, bounds) => ipcRenderer.send('browser:set-bounds', { tabId, bounds }),
      show: (tabId) => ipcRenderer.send('browser:show', { tabId }),
      hide: (tabId) => ipcRenderer.send('browser:hide', { tabId }),
      loadURL: (tabId, url) => ipcRenderer.invoke('browser:load-url', { tabId, url }),
      back: (tabId) => ipcRenderer.invoke('browser:back', { tabId }),
      forward: (tabId) => ipcRenderer.invoke('browser:forward', { tabId }),
      reload: (tabId) => ipcRenderer.invoke('browser:reload', { tabId }),
      stop: (tabId) => ipcRenderer.invoke('browser:stop', { tabId }),
      click: (tabId, selector) => ipcRenderer.invoke('browser:click', { tabId, selector }),
      type: (tabId, selector, text) => ipcRenderer.invoke('browser:type', { tabId, selector, text }),
      eval: (tabId, expression) => ipcRenderer.invoke('browser:eval', { tabId, expression }),
      waitFor: (tabId, selector, opts) => ipcRenderer.invoke('browser:wait-for', { tabId, selector, ...(opts || {}) }),
      screenshot: (tabId) => ipcRenderer.invoke('browser:screenshot', { tabId }),
      getText: (tabId) => ipcRenderer.invoke('browser:get-text', { tabId }),
      info: (tabId) => ipcRenderer.invoke('browser:info', { tabId }),
      on: subscribe,
    },
    modelHost: {
      onRequest: (fn) => subscribe('model:request', fn),
      reply: (msg) => ipcRenderer.send('model:reply', msg),
      chunk: (msg) => ipcRenderer.send('model:chunk', msg),
      ready: () => ipcRenderer.send('model:ready'),
    },
    editor: {
      // Agent renderer asks main to open a file in the editor window.
      openFile: (path) => ipcRenderer.invoke('editor:open-file', { path }),
      // Editor renderer signals "I'm loaded, push pending opens".
      ready: () => ipcRenderer.send('editor:ready'),
      // File-tree change-root flow: persists editorRoot AND adds the
      // path to the editor scope in one IPC.
      setRoot: (path) => ipcRenderer.invoke('editor:set-root', { path }),
      // Editor renderer subscribes to load-file pushes from main.
      onLoadFile: (fn) => subscribe('editor:load-file', fn),
      // Editor renderer reports its active-tab title so main can
      // update the OS window title.
      setTitle: (title) => ipcRenderer.send('editor:set-title', { title }),
      // Editor renderer publishes the active tab's content/dirty/mtime
      // so main can prepend it to chat-worker prompts. Pass null to clear.
      reportActiveTab: (tab) => ipcRenderer.send('editor:active-tab', tab || {}),
    },
    pty: {
      start: (opts) => ipcRenderer.invoke('pty:start', opts || {}),
      write: (paneId, data) => ipcRenderer.send('pty:input', { paneId, data }),
      resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', { paneId, cols, rows }),
      kill: (paneId) => ipcRenderer.send('pty:kill', { paneId }),
      onData: (fn) => subscribe('pty:data', fn),
      onExit: (fn) => subscribe('pty:exit', fn),
    },
  };
}

module.exports = { installEventForwarders, buildTransport, ALL_FORWARDED_CHANNELS };

// --- Real-environment installer -----------------------------------------
// Skipped under MYAGENT_TEST_PRELOAD_NOINSTALL so unit tests can import
// this module without invoking electron's contextBridge / ipcRenderer
// (which only exist inside a real preload context). Tests set the env
// var, import the pure functions, and drive them with fakes.

if (!process.env.MYAGENT_TEST_PRELOAD_NOINSTALL) {
  const { contextBridge, ipcRenderer, clipboard } = require('electron');
  const listeners = new Map();
  installEventForwarders({ ipcRenderer, listeners });
  contextBridge.exposeInMainWorld(
    'transport',
    buildTransport({ ipcRenderer, clipboard, listeners }),
  );
}
