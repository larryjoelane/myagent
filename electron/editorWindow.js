// Editor window manager. Owns the secondary BrowserWindow that hosts
// the file-tabs + file-editor surface (Phase 3 of the file-explorer
// feature). Lazy: no window exists until the first editor:open-file
// IPC. Persistent: closing the window with the OS [×] hides it
// instead of destroying it, so the next file open re-shows the same
// window (preserves tabs + scroll state across show/hide cycles).
// Destroyed for real on app quit.
//
// Plumbing: agent renderer calls transport.editor.openFile(path) →
// ipcMain handler invokes ensureWindow().loadFile(path) → manager
// pushes 'editor:load-file' over IPC to the editor renderer once it
// signals 'editor:ready'.

const path = require('path');
const { BrowserWindow } = require('electron');

class EditorWindowManager {
  /**
   * @param {object} opts
   * @param {string} opts.preloadPath - absolute path to electron/preload.js
   * @param {string} opts.projectRoot - used to resolve the prod editor.html
   * @param {string} [opts.devServerUrl] - vite dev server base, when set
   */
  constructor({ preloadPath, projectRoot, devServerUrl }) {
    this._preloadPath = preloadPath;
    this._projectRoot = projectRoot;
    this._devServerUrl = devServerUrl || null;
    /** @type {BrowserWindow | null} */
    this._win = null;
    /** Pending file-open requests queued before the renderer signals ready. */
    this._pending = [];
    this._ready = false;
    /**
     * Active editor tab as last reported by the editor renderer. Read
     * by the auto-context provider so chat workers can prepend the
     * active file to the user's prompt. Null = no editor open.
     * @type {{path: string, content: string, dirty: boolean, savedMtime: number} | null}
     */
    this._activeTab = null;
  }

  /** Renderer reports its active tab. Called from editor:active-tab IPC. */
  setActiveTab(tab) {
    if (!tab || typeof tab !== 'object' || !tab.path) {
      this._activeTab = null;
      return;
    }
    this._activeTab = {
      path: String(tab.path),
      content: typeof tab.content === 'string' ? tab.content : '',
      dirty: !!tab.dirty,
      savedMtime: typeof tab.savedMtime === 'number' ? tab.savedMtime : 0,
    };
  }

  /** Snapshot the active tab for the contextProvider. Returns null when
   *  the editor window is closed/destroyed or no tab is active. */
  getActiveTab() {
    if (!this._win || this._win.isDestroyed()) return null;
    return this._activeTab;
  }

  /**
   * Ensure the editor window exists and is visible. Creates lazily.
   * If the window was previously hidden, re-shows it.
   * @returns {BrowserWindow}
   */
  ensureWindow() {
    if (this._win && !this._win.isDestroyed()) {
      if (!this._win.isVisible()) this._win.show();
      this._win.focus();
      return this._win;
    }
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      backgroundColor: '#1e1e1e',
      title: 'Editor',
      webPreferences: {
        preload: this._preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this._win = win;
    this._ready = false;
    if (this._devServerUrl) {
      win.loadURL(`${this._devServerUrl.replace(/\/$/, '')}/editor.html`);
    } else {
      win.loadFile(path.join(this._projectRoot, 'renderer', 'dist', 'editor.html'));
    }
    // Hide instead of destroying so re-opening a file keeps tabs.
    win.on('close', (ev) => {
      if (this._destroying) return;
      ev.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      if (this._win === win) {
        this._win = null;
        this._ready = false;
        this._activeTab = null;
      }
    });
    return win;
  }

  /** Renderer signals it has loaded and registered its event handlers. */
  markReady() {
    this._ready = true;
    if (!this._win || this._win.isDestroyed()) return;
    const queue = this._pending;
    this._pending = [];
    for (const p of queue) this._send('editor:load-file', { path: p });
  }

  /**
   * Push a file open to the editor window. Window is created on demand;
   * if the renderer hasn't reported ready yet the request is queued.
   * @param {string} filePath
   */
  openFile(filePath) {
    this.ensureWindow();
    if (this._ready) {
      this._send('editor:load-file', { path: filePath });
    } else {
      this._pending.push(filePath);
    }
  }

  /** Update the window's OS title. Called from the renderer when the
   *  active tab changes. Falls back to "Editor" for empty input. */
  setTitle(/** @type {string} */ title) {
    if (!this._win || this._win.isDestroyed()) return;
    try { this._win.setTitle(title || 'Editor'); } catch { /* ignore */ }
  }

  /** Permanently close the editor window. Called from app before-quit. */
  destroy() {
    this._destroying = true;
    if (this._win && !this._win.isDestroyed()) {
      try { this._win.destroy(); } catch { /* ignore */ }
    }
    this._win = null;
    this._pending = [];
    this._ready = false;
    this._activeTab = null;
  }

  _send(channel, payload) {
    if (!this._win || this._win.isDestroyed()) return;
    try { this._win.webContents.send(channel, payload); }
    catch { /* renderer torn down — drop */ }
  }
}

module.exports = { EditorWindowManager };
