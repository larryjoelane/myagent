// EditorWindowManager tests — exercises lazy creation, ready-queue
// drain, hide-on-close, and the public API (openFile / setTitle /
// destroy) without spinning up a real Electron BrowserWindow. We
// inject a fake BrowserWindow constructor via module-level
// monkey-patching of the `electron` require cache.
//
// What we want to verify (one per case):
//   - no window created on construction (lazy)
//   - first openFile creates the window and queues the path
//   - markReady drains the queue with editor:load-file sends
//   - subsequent openFile after ready sends synchronously
//   - re-show on openFile when window was hidden
//   - close() event triggers hide(), not destroy()
//   - setTitle is forwarded to the BrowserWindow
//   - destroy() tears down for real and clears state

const path = require('path');
const { eq, ok, deepEq } = require('./assert');

// Build a fake BrowserWindow class. Each instance records loadURL /
// loadFile / webContents.send / show / hide / focus / setTitle calls
// and hosts a tiny event registry for 'close'/'closed'.
function makeFakeBrowserWindow() {
  const instances = [];
  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this._destroyed = false;
      this._visible = true;
      this._title = opts?.title || '';
      this._listeners = new Map();
      this._sent = [];
      this._loaded = null;
      this.webContents = {
        send: (channel, payload) => this._sent.push({ channel, payload }),
      };
      instances.push(this);
    }
    loadURL(url) { this._loaded = { kind: 'url', value: url }; }
    loadFile(file) { this._loaded = { kind: 'file', value: file }; }
    on(event, fn) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(fn);
    }
    show() { this._visible = true; }
    hide() { this._visible = false; }
    focus() { /* noop */ }
    isVisible() { return this._visible; }
    isDestroyed() { return this._destroyed; }
    setTitle(t) { this._title = t; }
    destroy() { this._destroyed = true; this._fire('closed', {}); }
    // test helpers
    _fire(event, ev) {
      for (const fn of this._listeners.get(event) || []) fn(ev);
    }
  }
  return { FakeBrowserWindow, instances };
}

// Replace `electron` in the module cache for the duration of a test.
// EditorWindowManager only pulls BrowserWindow from electron, so we
// only need to stub that key.
function withFakeElectron(FakeBrowserWindow, fn) {
  const electronKey = require.resolve('electron');
  const originalEntry = require.cache[electronKey];
  // Stub: a synthetic module exporting the fake.
  require.cache[electronKey] = {
    id: electronKey,
    filename: electronKey,
    loaded: true,
    exports: { BrowserWindow: FakeBrowserWindow },
  };
  // Drop EditorWindowManager from cache so it picks up the fake on next require.
  const ewKey = require.resolve('../electron/editorWindow');
  delete require.cache[ewKey];
  try { return fn(); }
  finally {
    if (originalEntry) require.cache[electronKey] = originalEntry;
    else delete require.cache[electronKey];
    delete require.cache[ewKey];
  }
}

exports.run = (ctx) => {
  ctx.test('does not create a BrowserWindow until openFile is called', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      eq(instances.length, 0, 'no window before openFile');
      // Sanity: the manager exists and exposes the public surface.
      eq(typeof mgr.openFile, 'function');
      eq(typeof mgr.markReady, 'function');
      eq(typeof mgr.setTitle, 'function');
      eq(typeof mgr.destroy, 'function');
    });
  });

  ctx.test('first openFile creates the window and queues the path until markReady', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      mgr.openFile('/some/file.js');
      eq(instances.length, 1, 'one window created');
      const win = instances[0];
      // Nothing sent yet — renderer hasn't said it's ready.
      eq(win._sent.length, 0, 'no sends queued before ready');
      // Production loads either dev URL or built file; with no
      // devServerUrl we should hit loadFile pointing at editor.html.
      ok(win._loaded, 'window loaded a target');
      eq(win._loaded.kind, 'file');
      contains(win._loaded.value, 'editor.html');
    });
  });

  ctx.test('markReady drains the queued opens via editor:load-file', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      mgr.openFile('/a.js');
      mgr.openFile('/b.js');
      const win = instances[0];
      eq(win._sent.length, 0);
      mgr.markReady();
      eq(win._sent.length, 2, 'both queued opens drained');
      eq(win._sent[0].channel, 'editor:load-file');
      deepEq(win._sent[0].payload, { path: '/a.js' });
      deepEq(win._sent[1].payload, { path: '/b.js' });
    });
  });

  ctx.test('openFile after markReady sends synchronously, no queue', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      mgr.openFile('/a.js');
      mgr.markReady();
      const win = instances[0];
      win._sent.length = 0;
      mgr.openFile('/b.js');
      eq(win._sent.length, 1);
      deepEq(win._sent[0].payload, { path: '/b.js' });
    });
  });

  ctx.test('close event hides instead of destroying; subsequent openFile re-shows', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      mgr.openFile('/a.js');
      const win = instances[0];
      // Simulate the user clicking the OS close [×]. The handler must
      // call preventDefault() and hide the window.
      let prevented = false;
      win._fire('close', { preventDefault() { prevented = true; } });
      eq(prevented, true, 'close was prevented');
      eq(win._visible, false, 'window hidden');
      eq(win._destroyed, false, 'NOT destroyed');
      // Now another file open should re-show the SAME window.
      mgr.openFile('/b.js');
      eq(instances.length, 1, 'no new window created');
      eq(win._visible, true, 'window re-shown');
    });
  });

  ctx.test('setTitle forwards to the BrowserWindow', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      // No-op when no window exists yet.
      mgr.setTitle('ignored');
      eq(instances.length, 0);
      mgr.openFile('/a.js');
      const win = instances[0];
      mgr.setTitle('foo.js — /a/b/foo.js');
      eq(win._title, 'foo.js — /a/b/foo.js');
      // Empty title falls back to "Editor".
      mgr.setTitle('');
      eq(win._title, 'Editor');
    });
  });

  ctx.test('destroy() tears the window down for real and clears pending state', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
      });
      mgr.openFile('/a.js'); // queues a pending open
      const win = instances[0];
      mgr.destroy();
      eq(win._destroyed, true);
      // A subsequent openFile should create a NEW window.
      mgr.openFile('/b.js');
      eq(instances.length, 2, 'destroyed manager creates a fresh window on next open');
    });
  });

  ctx.test('setActiveTab/getActiveTab: stores normalized snapshot, null clears', () => {
    const { FakeBrowserWindow } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js', projectRoot: '/fake/root',
      });
      // No tab + no window → null.
      eq(mgr.getActiveTab(), null);
      // Even with a tab set, getActiveTab returns null while no window
      // exists (the contextProvider only cares about live editors).
      mgr.setActiveTab({ path: '/p/a.js', content: 'x', dirty: true, savedMtime: 5 });
      eq(mgr.getActiveTab(), null, 'no window → null');
      // Open a window; now the snapshot is visible.
      mgr.openFile('/p/a.js');
      const tab = mgr.getActiveTab();
      ok(tab, 'tab snapshot exists');
      eq(tab.path, '/p/a.js');
      eq(tab.content, 'x');
      eq(tab.dirty, true);
      eq(tab.savedMtime, 5);
      // Coerces missing fields to safe defaults.
      mgr.setActiveTab({ path: '/p/b.js' });
      const t2 = mgr.getActiveTab();
      eq(t2.content, '');
      eq(t2.dirty, false);
      eq(t2.savedMtime, 0);
      // Falsy / missing-path payload clears.
      mgr.setActiveTab(null);
      eq(mgr.getActiveTab(), null);
      mgr.setActiveTab({ path: '/p/c.js' });
      mgr.setActiveTab({});
      eq(mgr.getActiveTab(), null, 'empty object clears the snapshot');
    });
  });

  ctx.test('destroy() clears the active-tab snapshot', () => {
    const { FakeBrowserWindow } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js', projectRoot: '/fake/root',
      });
      mgr.openFile('/p/a.js');
      mgr.setActiveTab({ path: '/p/a.js', content: 'x' });
      ok(mgr.getActiveTab());
      mgr.destroy();
      eq(mgr.getActiveTab(), null);
    });
  });

  ctx.test('uses devServerUrl when provided (Vite dev mode)', () => {
    const { FakeBrowserWindow, instances } = makeFakeBrowserWindow();
    withFakeElectron(FakeBrowserWindow, () => {
      const { EditorWindowManager } = require('../electron/editorWindow');
      const mgr = new EditorWindowManager({
        preloadPath: '/fake/preload.js',
        projectRoot: '/fake/root',
        devServerUrl: 'http://localhost:5173',
      });
      mgr.openFile('/a.js');
      const win = instances[0];
      eq(win._loaded.kind, 'url');
      eq(win._loaded.value, 'http://localhost:5173/editor.html');
    });
  });
};

// Local helper — assert.contains accepts strings only, but the value
// path may be undefined on Windows quirks; this is a substring check
// scoped to this file.
function contains(haystack, needle) {
  if (typeof haystack !== 'string' || haystack.indexOf(needle) === -1) {
    throw new Error(`expected substring ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}
