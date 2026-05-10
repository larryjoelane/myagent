// @ts-check
// <file-editor> — CodeMirror 6 editor pane for the editor BrowserWindow.
//
// Light-DOM Lit element: CM6 styling fights shadow DOM (its built-in
// theme injects styles into the document root, and selection / cursor
// metrics get measured through the shadow boundary in surprising ways).
// Light DOM keeps things simple at the cost of some style isolation —
// the editor window has no other CSS to clash with.
//
// Owns:
//   - the <file-tabs> child (renders inside this host)
//   - one CM6 EditorView reused across tabs (state swapped on activate)
//   - per-tab buffer state: { state, mtime, savedContent } in a Map
//
// Phase 4 adds save: Ctrl+S writes through transport.fs.writeFile.
// Per-tab dirty marker + lock icon. Locked tabs pass expectedMtime so
// the main-process handler refuses the write when the file changed
// underneath us (mtime-conflict). Unlocked tabs always overwrite.
//
// File loading goes through transport.fs.readFile (scope-checked in
// main). transport.editor.onLoadFile pushes from main when the agent
// renderer fires editor:open-file.

import { LitElement, html } from 'lit';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { go } from '@codemirror/lang-go';
import { csharp } from '@replit/codemirror-lang-csharp';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
// PowerShell mode lives under legacy-modes/mode/powershell.
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';

import './file-tabs.js';

/** @returns {any} */
function transport() { return /** @type {any} */ (window).transport; }

/** Pick a CM6 language extension by file extension. Defaults to no
 *  language (plain text) for unknown types. */
function languageFor(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([^.\\/]+)$/);
  if (!m) return [];
  const ext = m[1];
  switch (ext) {
    case 'py':   return python();
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'jsx': return javascript({ jsx: true });
    case 'go':   return go();
    case 'cs':   return csharp();
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'ps1': case 'psm1': case 'psd1': return StreamLanguage.define(powerShell);
    default:     return [];
  }
}

/** Build CM6 extensions for a given file. The save keymap and the
 *  update listener (for dirty tracking + title refresh) need a
 *  reference to the host — they're injected per-state at construction. */
function buildExtensions({ host, language }) {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    bracketMatching(),
    indentOnInput(),
    foldGutter(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      // Ctrl+S / Cmd+S → save active buffer. preventDefault stops the
      // browser-level "Save Page" dialog.
      { key: 'Mod-s', run: () => { void host._save(host._activePath); return true; } },
      // Ctrl+Shift+S / Cmd+Shift+S → Save As.
      { key: 'Mod-Shift-s', run: () => { void host._saveAs(host._activePath); return true; } },
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
    ]),
    // Recompute dirty state on every doc change. Cheap — string compare.
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      host._refreshDirty();
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': { fontFamily: "'Cascadia Code', Consolas, Menlo, monospace" },
    }, { dark: true }),
    ...(language ? [language] : []),
  ];
}

export class FileEditor extends LitElement {
  // Light DOM — CodeMirror 6 styling and measurement work best without
  // a shadow boundary.
  createRenderRoot() { return this; }

  static properties = {
    _activePath: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    /** @type {EditorView | null} */
    this._view = null;
    /**
     * @type {Map<string, {
     *   state: EditorState,
     *   mtime: number,         // mtime as of last load OR last save
     *   loadedContent: string, // canonical "saved" content for dirty diff
     *   locked: boolean,       // when true, save sends expectedMtime
     * }>}
     */
    this._buffers = new Map();
    this._activePath = '';
    this._error = '';
    /** @type {any} */
    this._tabs = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // Subscribe to load-file pushes from main. Stored so we can detach
    // on disconnect (test cleanliness; in prod the window owns the
    // element's lifetime).
    const t = transport();
    if (t?.editor?.onLoadFile) {
      this._unsubLoad = t.editor.onLoadFile((msg) => {
        if (msg && typeof msg.path === 'string') {
          void this._loadAndOpen(msg.path);
        }
      });
    }
    // Tell main we're ready — drains any opens queued before the
    // window's renderer finished booting.
    try { t?.editor?.ready?.(); } catch { /* ignore */ }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    try { this._unsubLoad?.(); } catch { /* ignore */ }
    if (this._view) {
      try { this._view.destroy(); } catch { /* ignore */ }
      this._view = null;
    }
  }

  firstUpdated() {
    this._tabs = /** @type {any} */ (this.querySelector('file-tabs'));
    this._tabs?.addEventListener('tab-activate', (/** @type {any} */ ev) => {
      this._activate(ev.detail?.path || '');
    });
    this._tabs?.addEventListener('tab-close', (/** @type {any} */ ev) => {
      this._close(ev.detail?.path || '');
    });
    this._tabs?.addEventListener('tab-toggle-lock', (/** @type {any} */ ev) => {
      this._toggleLock(ev.detail?.path || '');
    });
    this._mountView();
  }

  // --- buffer + view management --------------------------------------

  _mountView() {
    const host = /** @type {HTMLElement} */ (this.querySelector('#editor-host'));
    if (!host || this._view) return;
    this._view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: buildExtensions({ host: this, language: null }),
      }),
    });
    this._pushTitle();
  }

  /** Read a file via fs IPC and add it as a tab. Activates on success. */
  async _loadAndOpen(/** @type {string} */ path) {
    const t = transport();
    if (!t?.fs?.readFile) return;
    // Already open — just focus.
    if (this._buffers.has(path)) {
      this._tabs?.open(path);
      this._activate(path);
      return;
    }
    this._error = '';
    let r;
    try { r = await t.fs.readFile(path); }
    catch (err) { this._error = err?.message || String(err); return; }
    if (!r || !r.ok) {
      this._error = r?.error || 'failed to read file';
      return;
    }
    const content = r.content || '';
    const state = EditorState.create({
      doc: content,
      extensions: buildExtensions({ host: this, language: languageFor(path) }),
    });
    this._buffers.set(path, {
      state,
      mtime: r.mtime || 0,
      loadedContent: content,
      locked: false,
    });
    this._tabs?.open(path);
    this._tabs?.setTabState(path, { dirty: false, locked: false });
    this._activate(path);
  }

  /** Snapshot the current buffer (so edits persist when switching) and
   *  load the target buffer's state into the view. */
  _activate(/** @type {string} */ path) {
    if (!this._view) return;
    // Save current buffer state before switching.
    if (this._activePath && this._buffers.has(this._activePath)) {
      const cur = /** @type {any} */ (this._buffers.get(this._activePath));
      cur.state = this._view.state;
    }
    if (!path) {
      this._activePath = '';
      this._view.setState(EditorState.create({
        doc: '',
        extensions: buildExtensions({ host: this, language: null }),
      }));
      this._pushTitle();
      return;
    }
    const buf = this._buffers.get(path);
    if (!buf) return;
    this._view.setState(buf.state);
    this._activePath = path;
    this._tabs?.activate(path);
    this._pushTitle();
    // Refocus so typing lands in the editor immediately.
    queueMicrotask(() => this._view?.focus());
  }

  _close(/** @type {string} */ path) {
    const buf = this._buffers.get(path);
    if (!buf) return;
    // Snapshot active buffer first so the dirty check below sees the
    // latest doc, not the stale state.
    if (this._activePath === path && this._view) {
      buf.state = this._view.state;
    }
    if (this._isDirty(path) && !window.confirm(`Discard unsaved changes to ${basename(path)}?`)) {
      return;
    }
    this._buffers.delete(path);
    this._tabs?.close(path);
    if (this._activePath === path) {
      const next = this._tabs?.activePath || '';
      this._activate(next);
    }
  }

  // --- save flow ------------------------------------------------------

  /** Compare the active buffer's doc against its loadedContent and
   *  reflect the result on the tab strip + window title. */
  _refreshDirty() {
    const path = this._activePath;
    if (!path) return;
    const dirty = this._isDirty(path);
    this._tabs?.setTabState(path, { dirty });
    this._pushTitle();
  }

  /** Read the up-to-date doc string for a buffer (active uses the live
   *  view; inactive falls back to its snapshotted state). */
  _docFor(/** @type {string} */ path) {
    const buf = this._buffers.get(path);
    if (!buf) return '';
    if (this._activePath === path && this._view) {
      return this._view.state.doc.toString();
    }
    return buf.state.doc.toString();
  }

  _isDirty(/** @type {string} */ path) {
    const buf = this._buffers.get(path);
    if (!buf) return false;
    return this._docFor(path) !== buf.loadedContent;
  }

  /** Toggle the lock state for a tab. Locked tabs send expectedMtime
   *  on save so a stale write surfaces as mtime-conflict. */
  _toggleLock(/** @type {string} */ path) {
    const buf = this._buffers.get(path);
    if (!buf) return;
    buf.locked = !buf.locked;
    this._tabs?.setTabState(path, { locked: buf.locked });
  }

  /** Save the active buffer to disk. Called from Ctrl+S keymap. */
  async _save(/** @type {string} */ path) {
    if (!path) return;
    const buf = this._buffers.get(path);
    if (!buf) return;
    const t = transport();
    if (!t?.fs?.writeFile) return;
    // Snapshot the live view into the buffer's state so subsequent
    // tab switches see the saved content as-of-now.
    if (this._activePath === path && this._view) {
      buf.state = this._view.state;
    }
    const content = this._docFor(path);
    const opts = buf.locked ? { expectedMtime: buf.mtime } : {};
    this._error = '';
    let r;
    try { r = await t.fs.writeFile(path, content, opts); }
    catch (err) { this._error = err?.message || String(err); return; }
    if (!r || !r.ok) {
      if (r?.reason === 'mtime-conflict') {
        this._error = `${basename(path)}: file changed on disk since it was loaded. Unlock the tab to overwrite, or close and reopen to reload.`;
      } else {
        this._error = r?.error || 'save failed';
      }
      return;
    }
    // Success — adopt the new mtime and the new "loaded" baseline so
    // the dirty marker clears.
    buf.mtime = typeof r.mtime === 'number' ? r.mtime : buf.mtime;
    buf.loadedContent = content;
    this._tabs?.setTabState(path, { dirty: false });
    this._pushTitle();
  }

  /** Save the active buffer to a new path picked via native dialog.
   *  Adds the chosen directory to the editor scope so the write
   *  isn't refused, then writes (no expectedMtime — Save As never
   *  conflicts because the destination is user-confirmed). On
   *  success, re-keys the open buffer/tab to the new path. */
  async _saveAs(/** @type {string} */ path) {
    if (!path) return;
    const buf = this._buffers.get(path);
    if (!buf) return;
    const t = transport();
    if (!t?.dialog?.saveFile || !t?.fs?.writeFile) return;
    let res;
    try {
      res = await t.dialog.saveFile({
        title: 'Save As',
        defaultPath: path,
      });
    } catch { return; }
    if (!res || res.canceled || !res.path) return;
    const newPath = res.path;
    // Make sure the destination's directory is in scope before the
    // write — otherwise fs:write-file refuses it.
    try {
      const dir = parentDir(newPath);
      if (dir) await t.fs.scopeAdd?.(dir);
    } catch { /* fall through; the write will surface a clean error */ }
    // Snapshot the live view so we write the latest content.
    if (this._activePath === path && this._view) {
      buf.state = this._view.state;
    }
    const content = this._docFor(path);
    this._error = '';
    let r;
    try { r = await t.fs.writeFile(newPath, content, {}); }
    catch (err) { this._error = err?.message || String(err); return; }
    if (!r || !r.ok) {
      this._error = r?.error || 'save failed';
      return;
    }
    // Re-key the buffer to the new path. If the new path collides with
    // another open tab, close that one first to avoid two tabs pointing
    // at the same file.
    if (newPath !== path) {
      if (this._buffers.has(newPath)) {
        this._buffers.delete(newPath);
        this._tabs?.close(newPath);
      }
      this._buffers.delete(path);
      this._buffers.set(newPath, {
        state: buf.state,
        mtime: typeof r.mtime === 'number' ? r.mtime : 0,
        loadedContent: content,
        locked: buf.locked,
      });
      this._tabs?.close(path);
      this._tabs?.open(newPath);
      this._tabs?.setTabState(newPath, { dirty: false, locked: buf.locked });
      this._activePath = newPath;
      this._tabs?.activate(newPath);
    } else {
      buf.mtime = typeof r.mtime === 'number' ? r.mtime : buf.mtime;
      buf.loadedContent = content;
      this._tabs?.setTabState(path, { dirty: false });
    }
    this._pushTitle();
  }

  /** Push the active tab's title to main so the OS window title
   *  reflects the file. Empty path → "Editor". Also publishes the
   *  active-tab snapshot for the chat auto-context provider. */
  _pushTitle() {
    const t = transport();
    if (!t?.editor) return;
    if (!this._activePath) {
      try { t.editor.setTitle?.('Editor'); } catch { /* ignore */ }
      try { t.editor.reportActiveTab?.(null); } catch { /* ignore */ }
      return;
    }
    const path = this._activePath;
    const name = basename(path);
    const buf = this._buffers.get(path);
    const dirty = this._isDirty(path);
    try { t.editor.setTitle?.(`${dirty ? '● ' : ''}${name} — ${path}`); } catch { /* ignore */ }
    if (buf) {
      try {
        t.editor.reportActiveTab?.({
          path,
          content: this._docFor(path),
          dirty,
          savedMtime: buf.mtime || 0,
        });
      } catch { /* ignore */ }
    }
  }

  // --- rendering -----------------------------------------------------

  render() {
    const hasActive = !!this._activePath;
    return html`
      <style>
        file-editor { display: flex; flex-direction: column; height: 100vh; background: var(--bg, #1e1e1e); color: var(--text, #dcdcdc); }
        file-editor #editor-host { flex: 1 1 auto; min-height: 0; overflow: hidden; }
        file-editor #editor-host .cm-editor { height: 100%; }
        file-editor #editor-error {
          padding: 6px 10px;
          background: var(--warn-bg, #4a3030);
          color: var(--warn, #f88);
          font-size: 12px;
          font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        }
        file-editor #editor-toolbar {
          display: flex;
          gap: 6px;
          padding: 4px 8px;
          background: var(--surface-2, #2a2a2a);
          border-bottom: 1px solid var(--border, #404040);
          flex: 0 0 auto;
        }
        file-editor #editor-toolbar button {
          background: var(--surface-3, #333);
          color: var(--text, #dcdcdc);
          border: 1px solid var(--border, #404040);
          padding: 3px 10px;
          font: inherit;
          font-size: 12px;
          border-radius: 3px;
          cursor: pointer;
        }
        file-editor #editor-toolbar button:hover:not(:disabled) {
          background: var(--accent-bg, #4a4a4a);
          color: var(--accent-fg, #fff);
        }
        file-editor #editor-toolbar button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
      </style>
      <div id="editor-toolbar">
        <button type="button" id="ed-save"
                ?disabled=${!hasActive}
                title="Save (Ctrl+S)"
                @click=${() => void this._save(this._activePath)}>Save</button>
        <button type="button" id="ed-save-as"
                ?disabled=${!hasActive}
                title="Save As… (Ctrl+Shift+S)"
                @click=${() => void this._saveAs(this._activePath)}>Save As…</button>
      </div>
      <file-tabs></file-tabs>
      ${this._error ? html`<div id="editor-error">${this._error}</div>` : ''}
      <div id="editor-host"></div>
    `;
  }
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function parentDir(p) {
  if (!p) return '';
  const s = String(p);
  // Preserve native separator so Scope.contains (platform-aware) matches.
  const sep = s.includes('\\') && !s.includes('/') ? '\\' : '/';
  const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (idx <= 0) return '';
  return s.slice(0, idx) + (idx === 2 && sep === '\\' ? '\\' : ''); // keep "C:\" trailing sep
}

customElements.define('file-editor', FileEditor);
