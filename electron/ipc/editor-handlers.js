// IPC handlers for the secondary editor BrowserWindow (Phase 3 of the
// file-explorer feature).
//
//   editor:open-file        — agent renderer asks main to open a file in
//                             the editor window. Lazy-creates the window.
//   editor:ready            — editor renderer signals it has finished
//                             loading and is ready to receive load-file
//                             pushes. Drains any queued opens.
//   editor:set-root         — change the file-tree root: persists
//                             editorRoot in app settings AND adds the
//                             path to the editor scope so fs:* IPC
//                             accepts it. Returns the resolved root.
//
// File reads themselves go through fs:read-file (already in scope-checked
// fs-handlers.js). The editor window just receives 'editor:load-file' and
// invokes that itself.
//
// Wired in from electron/main.js via register(deps).

/**
 * @typedef {object} EditorHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('../editorWindow').EditorWindowManager} editorWindow
 * @property {import('../../src/core/scope').Scope} scope
 * @property {import('../../src/core/appSettings').AppSettings} appSettings
 */

/** @param {EditorHandlerDeps} deps */
function register({ ipcMain, editorWindow, scope, appSettings }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('editor-handlers: ipcMain is required');
  }
  if (!editorWindow) throw new Error('editor-handlers: editorWindow is required');
  if (!scope) throw new Error('editor-handlers: scope is required');
  if (!appSettings) throw new Error('editor-handlers: appSettings is required');

  ipcMain.handle('editor:open-file', async (_e, body = {}) => {
    if (!body.path || typeof body.path !== 'string') {
      return { ok: false, reason: 'bad-input', error: 'path is required' };
    }
    if (!(await scope.contains(body.path))) {
      return {
        ok: false,
        reason: 'out-of-scope',
        error: `path '${body.path}' is outside allowed scopes`,
      };
    }
    editorWindow.openFile(body.path);
    return { ok: true };
  });

  ipcMain.on('editor:ready', () => {
    editorWindow.markReady();
  });

  ipcMain.on('editor:set-title', (_e, body = {}) => {
    if (typeof body.title === 'string') editorWindow.setTitle(body.title);
  });

  // Editor renderer reports its active tab on every activate / dirty
  // change / save. Stored on the editor window manager so the chat
  // auto-context provider can read it. Body shape:
  //   { path, content, dirty, savedMtime } — or null/empty to clear.
  ipcMain.on('editor:active-tab', (_e, body = {}) => {
    editorWindow.setActiveTab(body && body.path ? body : null);
  });

  ipcMain.handle('editor:set-root', async (_e, body = {}) => {
    if (!body.path || typeof body.path !== 'string') {
      return { ok: false, reason: 'bad-input', error: 'path is required' };
    }
    let resolved;
    try {
      resolved = await scope.add(body.path);
    } catch (err) {
      return { ok: false, reason: 'io', error: err.message };
    }
    appSettings.set('editorRoot', resolved);
    return { ok: true, root: resolved, roots: scope.list() };
  });
}

module.exports = { register };
