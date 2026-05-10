// editor-handlers IPC tests. Drive the handlers through a fake
// ipcMain so we can fire events as the real bridge would.
//
// Coverage:
//   - editor:open-file routes through the editorWindow when in scope
//   - editor:open-file refuses out-of-scope paths
//   - editor:open-file rejects bad input (missing path)
//   - editor:ready forwards to editorWindow.markReady
//   - editor:set-title forwards to editorWindow.setTitle
//   - editor:set-root persists editorRoot AND adds the path to the scope

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Scope } = require('../src/core/scope');
const editorHandlers = require('../electron/ipc/editor-handlers');
const { eq, ok, deepEq, contains } = require('./assert');

// Fake ipcMain that records handle('x:y', fn) and on('x:y', fn) so
// the test can fire either kind. handle() is async; on() is fire-
// and-forget.
function fakeIpcMain() {
  const invokers = new Map(); // channel → fn(_e, body) → Promise<reply>
  const onListeners = new Map(); // channel → fn(_e, body)
  return {
    handle(channel, fn) { invokers.set(channel, fn); },
    on(channel, fn) {
      if (!onListeners.has(channel)) onListeners.set(channel, []);
      onListeners.get(channel).push(fn);
    },
    // Test helpers — invoke a registered .handle channel and resolve.
    async _invoke(channel, body) {
      const fn = invokers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      return await fn({}, body);
    },
    _fire(channel, body) {
      const list = onListeners.get(channel) || [];
      for (const fn of list) fn({}, body);
    },
    _channels() {
      return {
        handle: [...invokers.keys()],
        on: [...onListeners.keys()],
      };
    },
  };
}

// Fake EditorWindowManager — records what main.js delegates to it.
function fakeEditorWindow() {
  const calls = [];
  return {
    openFile(p) { calls.push({ method: 'openFile', path: p }); },
    markReady() { calls.push({ method: 'markReady' }); },
    setTitle(t) { calls.push({ method: 'setTitle', title: t }); },
    setActiveTab(tab) { calls.push({ method: 'setActiveTab', tab }); },
    destroy() { calls.push({ method: 'destroy' }); },
    _calls: calls,
  };
}

// Fake AppSettings with an in-memory Map; mirrors the get/set shape
// editor-handlers depends on.
function fakeAppSettings(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get(key, fallback) { return map.has(key) ? map.get(key) : fallback; },
    set(key, value) { map.set(key, value); },
    _all() { return Object.fromEntries(map); },
  };
}

async function tmpdir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'editor-handlers-'));
}
async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); }
  catch { /* ignore */ }
}

exports.run = (ctx) => {
  ctx.test('register: throws when ipcMain is missing', () => {
    let threw = null;
    try {
      editorHandlers.register({});
    } catch (err) { threw = err; }
    ok(threw, 'register without ipcMain should throw');
    contains(String(threw.message), 'ipcMain');
  });

  ctx.test('register: throws when editorWindow / scope / appSettings are missing', () => {
    const ipc = fakeIpcMain();
    for (const missing of ['editorWindow', 'scope', 'appSettings']) {
      const deps = {
        ipcMain: ipc,
        editorWindow: fakeEditorWindow(),
        scope: new Scope(['/']),
        appSettings: fakeAppSettings(),
      };
      delete deps[missing];
      let threw = null;
      try { editorHandlers.register(deps); } catch (err) { threw = err; }
      ok(threw, `register without ${missing} should throw`);
      contains(String(threw.message), missing);
    }
  });

  ctx.test('register: installs editor:open-file, editor:set-root (handle) and editor:ready, editor:set-title (on)', () => {
    const ipc = fakeIpcMain();
    editorHandlers.register({
      ipcMain: ipc,
      editorWindow: fakeEditorWindow(),
      scope: new Scope(['/']),
      appSettings: fakeAppSettings(),
    });
    const channels = ipc._channels();
    ok(channels.handle.includes('editor:open-file'),  'editor:open-file registered as handle');
    ok(channels.handle.includes('editor:set-root'),   'editor:set-root registered as handle');
    ok(channels.on.includes('editor:ready'),          'editor:ready registered as on');
    ok(channels.on.includes('editor:set-title'),      'editor:set-title registered as on');
  });

  ctx.test('editor:open-file forwards an in-scope path to editorWindow.openFile', async () => {
    const root = await tmpdir();
    try {
      const ipc = fakeIpcMain();
      const editor = fakeEditorWindow();
      editorHandlers.register({
        ipcMain: ipc,
        editorWindow: editor,
        scope: new Scope([root]),
        appSettings: fakeAppSettings(),
      });
      const target = path.join(root, 'a.txt');
      await fsp.writeFile(target, 'hi');
      const r = await ipc._invoke('editor:open-file', { path: target });
      eq(r.ok, true);
      eq(editor._calls.length, 1);
      eq(editor._calls[0].method, 'openFile');
      eq(editor._calls[0].path, target);
    } finally { await rmrf(root); }
  });

  ctx.test('editor:open-file refuses an out-of-scope path with reason "out-of-scope"', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const ipc = fakeIpcMain();
      const editor = fakeEditorWindow();
      editorHandlers.register({
        ipcMain: ipc,
        editorWindow: editor,
        scope: new Scope([a]),
        appSettings: fakeAppSettings(),
      });
      const r = await ipc._invoke('editor:open-file', { path: path.join(b, 'x.txt') });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
      eq(editor._calls.length, 0, 'editor window not touched');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('editor:open-file rejects missing/non-string path', async () => {
    const ipc = fakeIpcMain();
    const editor = fakeEditorWindow();
    editorHandlers.register({
      ipcMain: ipc,
      editorWindow: editor,
      scope: new Scope(['/']),
      appSettings: fakeAppSettings(),
    });
    let r = await ipc._invoke('editor:open-file', {});
    eq(r.ok, false); eq(r.reason, 'bad-input');
    r = await ipc._invoke('editor:open-file', { path: 42 });
    eq(r.ok, false); eq(r.reason, 'bad-input');
    eq(editor._calls.length, 0);
  });

  ctx.test('editor:ready forwards to editorWindow.markReady', () => {
    const ipc = fakeIpcMain();
    const editor = fakeEditorWindow();
    editorHandlers.register({
      ipcMain: ipc,
      editorWindow: editor,
      scope: new Scope(['/']),
      appSettings: fakeAppSettings(),
    });
    ipc._fire('editor:ready', {});
    eq(editor._calls.length, 1);
    eq(editor._calls[0].method, 'markReady');
  });

  ctx.test('editor:set-title forwards a string title; ignores non-string', () => {
    const ipc = fakeIpcMain();
    const editor = fakeEditorWindow();
    editorHandlers.register({
      ipcMain: ipc,
      editorWindow: editor,
      scope: new Scope(['/']),
      appSettings: fakeAppSettings(),
    });
    ipc._fire('editor:set-title', { title: 'foo.js — /tmp/foo.js' });
    eq(editor._calls.length, 1);
    eq(editor._calls[0].method, 'setTitle');
    eq(editor._calls[0].title, 'foo.js — /tmp/foo.js');
    // Non-string is dropped silently — the channel is fire-and-forget
    // and the renderer is the source of truth.
    ipc._fire('editor:set-title', { title: 42 });
    ipc._fire('editor:set-title', {});
    eq(editor._calls.length, 1, 'no extra setTitle calls for invalid payloads');
  });

  ctx.test('editor:set-root persists editorRoot in appSettings AND adds the path to the scope', async () => {
    const root = await tmpdir();
    try {
      const ipc = fakeIpcMain();
      const editor = fakeEditorWindow();
      const settings = fakeAppSettings();
      const scope = new Scope([]); // start empty so the add is observable
      editorHandlers.register({
        ipcMain: ipc, editorWindow: editor, scope, appSettings: settings,
      });
      const r = await ipc._invoke('editor:set-root', { path: root });
      eq(r.ok, true);
      ok(r.root, 'returned a resolved root');
      ok(Array.isArray(r.roots), 'returned current roots list');
      eq(r.roots.length, 1, 'scope now has one root');
      eq(typeof settings.get('editorRoot'), 'string');
      eq(settings.get('editorRoot'), r.root, 'editorRoot persisted');
      ok(await scope.contains(root), 'scope.contains the new root');
    } finally { await rmrf(root); }
  });

  ctx.test('editor:active-tab forwards a payload with a path to setActiveTab', () => {
    const ipc = fakeIpcMain();
    const editor = fakeEditorWindow();
    editorHandlers.register({
      ipcMain: ipc, editorWindow: editor,
      scope: new Scope(['/']), appSettings: fakeAppSettings(),
    });
    ipc._fire('editor:active-tab', {
      path: '/p/a.js', content: 'x = 1', dirty: true, savedMtime: 7,
    });
    eq(editor._calls.length, 1);
    eq(editor._calls[0].method, 'setActiveTab');
    deepEq(editor._calls[0].tab, {
      path: '/p/a.js', content: 'x = 1', dirty: true, savedMtime: 7,
    });
  });

  ctx.test('editor:active-tab with no path clears the snapshot (passes null)', () => {
    const ipc = fakeIpcMain();
    const editor = fakeEditorWindow();
    editorHandlers.register({
      ipcMain: ipc, editorWindow: editor,
      scope: new Scope(['/']), appSettings: fakeAppSettings(),
    });
    ipc._fire('editor:active-tab', {});
    eq(editor._calls.length, 1);
    eq(editor._calls[0].method, 'setActiveTab');
    eq(editor._calls[0].tab, null);
  });

  ctx.test('editor:set-root rejects bad input', async () => {
    const ipc = fakeIpcMain();
    const settings = fakeAppSettings();
    editorHandlers.register({
      ipcMain: ipc,
      editorWindow: fakeEditorWindow(),
      scope: new Scope([]),
      appSettings: settings,
    });
    const r = await ipc._invoke('editor:set-root', {});
    eq(r.ok, false);
    eq(r.reason, 'bad-input');
    eq(settings.get('editorRoot', null), null, 'editorRoot not touched on bad input');
  });
};
