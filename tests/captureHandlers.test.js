// capture-handlers IPC tests. Drive the handlers through a fake ipcMain
// + fake BrowserWindow so we can assert the dev gate and the file write
// without launching Electron.
//
// Coverage:
//   - capture:is-dev reports the isDev flag
//   - capture:screenshot writes a PNG under docs/screenshots when isDev
//   - capture:screenshot REFUSES when isDev is false (the production gate)
//   - capture:screenshot handles a missing/destroyed window
//   - safeLabel sanitizes a user label into one filename segment

const fs = require('fs');
const os = require('os');
const path = require('path');
const captureHandlers = require('../electron/ipc/capture-handlers');
const { eq, ok, contains } = require('./assert');

function fakeIpcMain() {
  const invokers = new Map();
  return {
    handle(channel, fn) { invokers.set(channel, fn); },
    async _invoke(channel, body, event) {
      const fn = invokers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      return await fn(event || {}, body);
    },
  };
}

// Fake NativeImage: non-empty PNG bytes unless told to be empty.
function fakeImage({ empty = false } = {}) {
  return {
    isEmpty() { return empty; },
    toPNG() { return Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); },
  };
}

// Fake BrowserWindow class with a static fromWebContents that returns the
// window we stashed on the event's sender.
function fakeBrowserWindow({ image = fakeImage(), destroyed = false } = {}) {
  const win = {
    isDestroyed() { return destroyed; },
    webContents: { async capturePage() { return image; } },
  };
  const BW = { fromWebContents(sender) { return sender && sender.__win ? sender.__win : null; } };
  return { BW, win, event: { sender: { __win: win } } };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-capture-test-'));
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

// Resolve `segs` under `base` and assert the result stays inside it before
// returning the path. Containment guard so fs.* sinks never receive a path
// that escaped the base via a `..` segment (satisfies the path-injection
// guardrail). Throws if an arg tries to traverse out.
function contained(base, ...segs) {
  const resolved = path.resolve(base, ...segs);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`path escapes base: ${resolved}`);
  }
  return resolved;
}

module.exports = function run(ctx) {
  ctx.test('capture:is-dev reports the isDev flag (true)', async () => {
    const ipcMain = fakeIpcMain();
    const { BW } = fakeBrowserWindow();
    captureHandlers.register({ ipcMain, BrowserWindow: BW, projectRoot: tmpRoot(), isDev: true });
    const r = await ipcMain._invoke('capture:is-dev');
    ok(r.ok, 'ok');
    eq(r.isDev, true, 'isDev true');
  });

  ctx.test('capture:is-dev reports isDev false in a packaged build', async () => {
    const ipcMain = fakeIpcMain();
    const { BW } = fakeBrowserWindow();
    captureHandlers.register({ ipcMain, BrowserWindow: BW, projectRoot: tmpRoot(), isDev: false });
    const r = await ipcMain._invoke('capture:is-dev');
    eq(r.isDev, false, 'isDev false');
  });

  ctx.test('capture:screenshot writes a PNG under docs/screenshots when isDev', async () => {
    const root = tmpRoot();
    const ipcMain = fakeIpcMain();
    const { BW, event } = fakeBrowserWindow();
    captureHandlers.register({ ipcMain, BrowserWindow: BW, projectRoot: root, isDev: true });
    const r = await ipcMain._invoke('capture:screenshot', { label: 'Chat Response!' }, event);
    ok(r.ok, 'ok');
    ok(fs.existsSync(r.path), 'file exists on disk');
    contains(r.path, path.join('docs', 'screenshots'), 'lands in docs/screenshots');
    contains(r.path, 'chat-response', 'label is sanitized into the name');
    ok(r.path.endsWith('.png'), 'png extension');
    rmrf(root);
  });

  ctx.test('capture:screenshot REFUSES when isDev is false (production gate)', async () => {
    const root = tmpRoot();
    const ipcMain = fakeIpcMain();
    const { BW, event } = fakeBrowserWindow();
    captureHandlers.register({ ipcMain, BrowserWindow: BW, projectRoot: root, isDev: false });
    const r = await ipcMain._invoke('capture:screenshot', {}, event);
    eq(r.ok, false, 'refused');
    eq(r.reason, 'not-dev', 'reason not-dev');
    // No screenshots directory should have been created.
    ok(!fs.existsSync(contained(root, 'docs', 'screenshots')), 'no file written');
    rmrf(root);
  });

  ctx.test('capture:screenshot reports no-window when the window is gone', async () => {
    const ipcMain = fakeIpcMain();
    const { BW } = fakeBrowserWindow();
    captureHandlers.register({ ipcMain, BrowserWindow: BW, projectRoot: tmpRoot(), isDev: true });
    // event whose sender has no window
    const r = await ipcMain._invoke('capture:screenshot', {}, { sender: {} });
    eq(r.ok, false, 'refused');
    eq(r.reason, 'no-window', 'reason no-window');
  });

  ctx.test('capture:screenshot reports empty on an empty frame', async () => {
    const root = tmpRoot();
    const ipcMain = fakeIpcMain();
    const { BW, event } = fakeBrowserWindow({ image: fakeImage({ empty: true }) });
    captureHandlers.register({ ipcMain, BrowserWindow: BW, projectRoot: root, isDev: true });
    const r = await ipcMain._invoke('capture:screenshot', {}, event);
    eq(r.ok, false, 'refused');
    eq(r.reason, 'empty', 'reason empty');
    rmrf(root);
  });

  ctx.test('safeLabel sanitizes to a single safe segment', () => {
    eq(captureHandlers.safeLabel('Chat & Response'), '-chat-response', 'spaces/punct → dashes');
    eq(captureHandlers.safeLabel('../etc/passwd'), '-etc-passwd', 'no path separators survive');
    eq(captureHandlers.safeLabel(''), '', 'empty stays empty');
    eq(captureHandlers.safeLabel(null), '', 'null stays empty');
  });
};
