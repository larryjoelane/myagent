// IPC handlers for the in-app browser tabs. Each tab is a BrowserView
// attached to a window; the renderer owns positioning (it reports the
// host element's bounds) and the agent-control surface (click/type/eval)
// is the same wire format worker tools call.
//
// Wired in from electron/main.js via register({ ipcMain, browserManager }).

/**
 * @typedef {object} BrowserHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('electron').BrowserWindow} BrowserWindow
 * @property {import('../../src/core/browserManager').BrowserManager} browserManager
 */

/** @param {BrowserHandlerDeps} deps */
function register({ ipcMain, BrowserWindow, browserManager }) {
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
}

module.exports = { register };
