const { contextBridge, ipcRenderer, clipboard } = require('electron');

const listeners = new Map();

const FORWARD = {
  'agent:chunk': 'chunk',
  'agent:done': 'done',
  'agent:error': 'error',
  'agent:tool-start': 'tool-start',
  'agent:tool-end': 'tool-end',
};
for (const [channel, event] of Object.entries(FORWARD)) {
  ipcRenderer.on(channel, (_e, msg) => emit(event, msg));
}

// PTY events carry { paneId, ... } so multiple panes can coexist. The
// shell subscribes via transport.pty.onData(paneId, fn) / onExit(...).
ipcRenderer.on('pty:data', (_e, msg) => emit('pty:data', msg));
ipcRenderer.on('pty:exit', (_e, msg) => emit('pty:exit', msg));

// Chat passthrough events from worker channels. agentId routes which
// chat tab the message belongs to.
for (const ev of ['chat:user', 'chat:turn-start', 'chat:chunk', 'chat:turn-end']) {
  ipcRenderer.on(ev, (_e, msg) => emit(ev, msg));
}

// Browser tab events. Renderer subscribers filter by tabId.
for (const ev of ['browser:nav', 'browser:title', 'browser:loading', 'browser:error']) {
  ipcRenderer.on(ev, (_e, msg) => emit(ev, msg));
}

// Generation streaming chunks. Subscribers filter by requestId.
ipcRenderer.on('models:generate-chunk', (_e, msg) => emit('models:generate-chunk', msg));

function emit(event, msg) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(msg);
}

contextBridge.exposeInMainWorld('transport', {
  kind: 'electron',
  // All agent calls accept an optional { runnerName, model } so the
  // renderer can target a specific runner+model picked via /agent flags.
  // Without those, the main process uses defaults (Ollama + env model).
  health: (opts) => ipcRenderer.invoke('agent:health', opts || {}),
  thinkStatus: (opts) => ipcRenderer.invoke('agent:think-status', opts || {}),
  setThink: (on, opts) => ipcRenderer.invoke('agent:set-think', { on, ...(opts || {}) }),
  runners: () => ipcRenderer.invoke('agent:runners'),
  run: (sessionId, prompt, opts) =>
    ipcRenderer.send('agent:run', { sessionId, prompt, ...(opts || {}) }),
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
  memory: {
    // Hybrid (BM25 + cosine) search over indexed session logs. Resolves
    // after any pending ingest completes, so freshly-written turns are
    // searchable as soon as agent:done fires.
    search: (query, opts) => ipcRenderer.invoke('memory:search', { query, ...(opts || {}) }),
    ingest: () => ipcRenderer.invoke('memory:ingest'),
    // Write a freeform memory directly. Body: { text, source?, tags?, ts? }.
    store: (body) => ipcRenderer.invoke('memory:store', body || {}),
  },
  // Headless workers — claude or shell — driven through the chat. The
  // chat UI calls these directly; previous "attach a PTY pane"
  // concept is gone.
  workers: {
    spawn: (body) => ipcRenderer.invoke('worker:spawn', body || {}),
    list: () => ipcRenderer.invoke('worker:list'),
    send: (body) => ipcRenderer.invoke('worker:send', body || {}),
    close: (body) => ipcRenderer.invoke('worker:close', body || {}),
    rename: (body) => ipcRenderer.invoke('worker:rename', body || {}),
    // Tools available to a worker (semantic kind only — claude/shell
    // return {ok:false}). Used by the renderer to drive slash-command
    // autocomplete.
    listTools: (id) => ipcRenderer.invoke('worker:list-tools', { id }),
  },
  // In-process model registry (Cut A: just the embedder). Renderer
  // reads embedder status to populate the Device dropdown on the
  // semantic-worker spawn UI.
  models: {
    embedderStatus: () => ipcRenderer.invoke('models:embedder-status'),
    embedderDevTools: () => ipcRenderer.invoke('models:embedder-devtools'),
    embedderBenchmark: (body) => ipcRenderer.invoke('models:embedder-benchmark', body || {}),
    list: (kind) => ipcRenderer.invoke('models:list', { kind }),
    generate: (body) => ipcRenderer.invoke('models:generate', body || {}),
    onGenerateChunk: (fn) => {
      if (!listeners.has('models:generate-chunk')) listeners.set('models:generate-chunk', new Set());
      listeners.get('models:generate-chunk').add(fn);
      return () => listeners.get('models:generate-chunk').delete(fn);
    },
  },
  // Native dialogs + persisted settings, used by the spawn UX.
  dialog: {
    chooseDirectory: (opts) => ipcRenderer.invoke('dialog:choose-directory', opts || {}),
  },
  settings: {
    get: (key, fallback) => ipcRenderer.invoke('settings:get', { key, fallback }),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  },
  // Lower-level multi-terminal registry. Used by bin/agent.js CLI and
  // the diagnostic test panel only — not by the chat UI.
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
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
  },
  // Embedded Chromium tabs. Each tab has a string `tabId` chosen by the
  // renderer; the main process tracks one BrowserView per id. Agent
  // control (click/type/eval/wait/screenshot) is on the same surface so
  // worker tools can drive it through the same handles the UI uses.
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
    // Subscribe to events. Caller filters by msg.tabId.
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
  },
  pty: {
    // All calls take a paneId so multiple PTYs can coexist (one per pane).
    start: (opts) => ipcRenderer.invoke('pty:start', opts || {}),
    write: (paneId, data) => ipcRenderer.send('pty:input', { paneId, data }),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', { paneId, cols, rows }),
    kill: (paneId) => ipcRenderer.send('pty:kill', { paneId }),
    // onData/onExit fire for ALL panes; subscriber must filter on paneId.
    onData: (fn) => {
      if (!listeners.has('pty:data')) listeners.set('pty:data', new Set());
      listeners.get('pty:data').add(fn);
      return () => listeners.get('pty:data').delete(fn);
    },
    onExit: (fn) => {
      if (!listeners.has('pty:exit')) listeners.set('pty:exit', new Set());
      listeners.get('pty:exit').add(fn);
      return () => listeners.get('pty:exit').delete(fn);
    },
  },
});
