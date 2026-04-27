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
