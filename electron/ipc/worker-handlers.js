// IPC handlers for the worker surface (chat-driven agents and shells)
// plus a few small adjacent surfaces:
//   - worker:spawn / list / list-tools / send / close / rename
//   - dialog:choose-directory — native picker for a worker's cwd
//   - settings:get / set — generic persisted UI settings
//   - chat:get-settings / set-default-mirror / set-worker-mirror —
//     memory-mirror controls
//
// Wired in from electron/main.js via register(deps).

/**
 * @typedef {object} WorkerHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('electron').BrowserWindow} BrowserWindow
 * @property {import('electron').Dialog} dialog
 * @property {import('../../src/core/workerManager').WorkerManager} workerManager
 * @property {import('../../src/core/appSettings').AppSettings} appSettings
 * @property {string} projectRoot
 */

/** @param {WorkerHandlerDeps} deps */
function register({ ipcMain, BrowserWindow, dialog, workerManager, appSettings, projectRoot }) {
  // --- Worker management --------------------------------------------------
  // Workers are headless agents (claude / shell / semantic) the chat drives.
  ipcMain.handle('worker:spawn', async (_e, body = {}) => {
    try {
      const kind = body.kind === 'shell'         ? 'shell'
                 : body.kind === 'semantic'      ? 'semantic'
                 : body.kind === 'ollama-cloud'  ? 'ollama-cloud'
                                                 : 'claude';
      const cwd = body.cwd || appSettings.get('lastCwd') || projectRoot;
      let result;
      if (kind === 'shell') {
        result = await workerManager.spawnShell({ name: body.name, cwd });
      } else if (kind === 'semantic') {
        result = await workerManager.spawnSemantic({ name: body.name, cwd });
      } else if (kind === 'ollama-cloud') {
        result = await workerManager.spawnOllamaCloud({
          name: body.name, cwd, model: body.model,
        });
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
    const defaultPath = body.defaultPath || appSettings.get('lastCwd') || projectRoot;
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

  // Ollama Cloud model picker. Reads OLLAMA_MODELS (comma-separated)
  // from .env; falls back to a sensible default list. The first entry
  // — or OLLAMA_MODEL when set — is the default selection.
  ipcMain.handle('worker:ollama-cloud-models', () => {
    const raw = (process.env.OLLAMA_MODELS || '').trim();
    const models = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['gpt-oss:120b-cloud', 'ibm/granite-docling'];
    const def = (process.env.OLLAMA_MODEL || models[0] || '').trim();
    return { ok: true, models, default: def };
  });

  // Tool list for a single worker (semantic only today). Returns
  // {ok:true, tools:[...]} or {ok:false, error} when the worker
  // doesn't exist / has no toolkit. Renderer uses this to drive
  // the slash-command autocomplete popup.
  ipcMain.handle('worker:list-tools', (_e, body = {}) => {
    const tools = workerManager.listTools(body.id);
    if (!tools) return { ok: false, error: 'no toolkit for worker' };
    return { ok: true, tools };
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

  // --- Memory-mirror controls ---------------------------------------------
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
}

module.exports = { register };
