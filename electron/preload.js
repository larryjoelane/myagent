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

function emit(event, msg) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(msg);
}

contextBridge.exposeInMainWorld('transport', {
  kind: 'electron',
  health: () => ipcRenderer.invoke('agent:health'),
  run: (sessionId, prompt) => ipcRenderer.send('agent:run', { sessionId, prompt }),
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
});
