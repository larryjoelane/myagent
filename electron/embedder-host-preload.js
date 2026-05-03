// Preload for the hidden embedder-host BrowserWindow.
// Keeps contextIsolation: true and exposes the narrowest possible
// surface — just a request listener and a reply sender. Main side
// initiates every conversation; the renderer never originates IPC.

const { contextBridge, ipcRenderer } = require('electron');

const handlers = new Set();

ipcRenderer.on('embedder:request', (_e, msg) => {
  for (const fn of handlers) fn(msg);
});

contextBridge.exposeInMainWorld('embedderHost', {
  onRequest(fn) { handlers.add(fn); return () => handlers.delete(fn); },
  reply(payload) { ipcRenderer.send('embedder:reply', payload); },
});
