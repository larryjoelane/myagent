// @ts-check
// <file-tree> — collapsible left-rail tree rooted at the editor's
// current scope (initially `pendingCwd`, grown via the Settings →
// Scopes panel in a later phase). Lazy-expand: a folder reads its
// children only when the user clicks to open it. Clicking a file
// dispatches a `file-open` CustomEvent (bubbles, composed) with
// `{ path }` — Phase 3 wires this to the editor window; for Phase 2
// the event has no consumer and the click is a no-op visually.
//
// Closed by default; the toggle lives in <topbar-commands> as the
// "Files" button. Width 240px when open. Persists `fileTreeOpen` and
// `fileTreeShowHidden` via transport.settings so preferences stick
// across reloads.
//
// Hidden directories: node_modules, .git, dist, .myagent are hidden
// by default; "Show hidden" toggle in the header reveals them via
// the showHidden flag forwarded to fs:list-dir.

import { LitElement, html, css } from 'lit';

/** @returns {any} */
function transport() { return /** @type {any} */ (window).transport; }

/** Folder entries lazy-expand. We track the loaded children +
 *  expanded state per path in this Map; absence == not loaded. */
class TreeState {
  constructor() {
    /** @type {Map<string, { entries: any[], expanded: boolean, loading: boolean, error: string | null }>} */
    this.byPath = new Map();
  }

  get(path) { return this.byPath.get(path); }
  set(path, value) { this.byPath.set(path, value); }
  has(path) { return this.byPath.has(path); }
  forget(path) { this.byPath.delete(path); }

  /** Drop everything cached. Used by the refresh button. */
  clear() { this.byPath.clear(); }
}

export class FileTree extends LitElement {
  static properties = {
    /** Caller controls open/closed. The host class toggles drive layout. */
    open: { type: Boolean, reflect: true },
    /** Show hidden directories (node_modules, .git, etc.). Persisted. */
    showHidden: { type: Boolean, reflect: false },
    /** Internal: the root the tree starts at. Falls back to the first
     *  scope root, or '' if neither is available. */
    _root: { state: true },
    /** Bumped on any tree mutation to force re-render — TreeState is
     *  a plain JS Map so Lit can't observe it directly. */
    _tick: { state: true },
    /** True while an fs:* call is in flight for the root. Used to
     *  show a small spinner / "loading" placeholder. */
    _rootLoading: { state: true },
    /** Open right-click context menu: { path, type, name, x, y } or null. */
    _ctx: { state: true },
    /** Open inline name-prompt overlay, or null. Electron disables the
     *  native window.prompt(), so we render our own in the shadow DOM:
     *  { title, value, placeholder, x, y, onSubmit: (name) => void }. */
    _prompt: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 0 0 240px;
      max-width: 50vw;
      background: var(--bg);
      border-right: 1px solid var(--border);
      font-size: 12px;
      color: var(--text);
      overflow: hidden;
      transition: flex-basis 160ms ease;
    }
    :host(:not([open])) {
      flex-basis: 0;
      border-right-width: 0;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-2);
      flex: 0 0 auto;
    }
    .title {
      flex: 1 1 auto;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .icon-btn {
      flex: 0 0 auto;
      background: transparent;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 2px 4px;
      font: inherit;
      font-size: 12px;
      border-radius: 3px;
    }
    .icon-btn:hover { background: var(--surface-3); color: var(--text); }
    .icon-btn[aria-pressed='true'] {
      background: var(--accent-bg);
      color: var(--accent-fg);
    }

    .body {
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 0;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
      font-family: 'Cascadia Code', Consolas, Menlo, monospace;
    }
    .row:hover { background: var(--surface-3); }
    .row.is-loading { color: var(--text-faint); cursor: default; }
    .row.is-error   { color: var(--warn); cursor: default; }

    .twisty {
      flex: 0 0 12px;
      width: 12px;
      text-align: center;
      color: var(--text-faint);
      font-size: 10px;
    }
    .twisty--placeholder { visibility: hidden; }

    .icon {
      flex: 0 0 14px;
      width: 14px;
      text-align: center;
      color: var(--text-dim);
    }
    .icon--folder { color: #c8a464; }
    .icon--file   { color: var(--text-faint); }

    .name {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .empty {
      padding: 12px 10px;
      color: var(--text-faint);
      font-size: 11px;
      text-align: center;
    }

    /* Right-click context menu (anchored at the cursor, fixed to viewport). */
    .ctx-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
    }
    .ctx-menu {
      position: fixed;
      z-index: 41;
      min-width: 160px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 6px 22px #0008;
      padding: 4px;
      font-size: 12px;
    }
    .ctx-title {
      padding: 4px 8px 6px;
      color: var(--text-dim);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-bottom: 1px solid var(--border);
      margin-bottom: 4px;
    }
    .ctx-item {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: var(--text);
      cursor: pointer;
      padding: 6px 8px;
      font: inherit;
      border-radius: 4px;
    }
    .ctx-item:hover { background: var(--surface-3); }
    .ctx-danger { color: var(--warn, #ff7a6b); }
    .ctx-danger:hover { background: var(--warn-bg, #3a1d1d); color: #ffb4ab; }
    .ctx-sep {
      height: 1px;
      background: var(--border, #404040);
      margin: 4px 0;
    }

    /* Inline name-prompt (window.prompt replacement — Electron disables it). */
    .np-backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
    }
    .np-box {
      position: fixed;
      z-index: 51;
      width: 220px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 6px 22px #0008;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .np-title {
      color: var(--text-dim);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .np-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--surface-1, #1a1a1a);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font: inherit;
      font-size: 12px;
      padding: 5px 7px;
      outline: none;
    }
    .np-input:focus { border-color: var(--accent, #5b9dd9); }
    .np-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }
    .np-btn {
      background: var(--surface-3, #2a2a2a);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      padding: 4px 10px;
    }
    .np-btn:hover { background: var(--surface-4, #333); }
    .np-ok {
      background: var(--accent, #3a6ea5);
      border-color: var(--accent, #3a6ea5);
      color: #fff;
    }
    .np-ok:hover { background: var(--accent-hover, #4a7eb5); }
  `;

  constructor() {
    super();
    this.open = false;
    this.showHidden = false;
    this._root = '';
    this._tick = 0;
    this._rootLoading = false;
    this._ctx = null;
    this._prompt = null;
    /** @type {TreeState} */
    this._tree = new TreeState();
  }

  connectedCallback() {
    super.connectedCallback();
    // Hydrate persisted preferences: open state + showHidden. Only the
    // open state changes layout; showHidden requires a refresh of the
    // currently-loaded folders (which we trigger by clearing the cache
    // when it flips).
    void this._hydrate();
    // Auto-refresh: invalidate cached directories whenever a worker
    // tool call mutates the filesystem. Cheap — we only re-read the
    // *parent directory* of the affected path, and only if it's
    // currently expanded. Misses external editor changes; covered by
    // the focus listener below.
    const t = transport();
    if (t?.chat?.on) {
      this._unsubTool = t.chat.on('chat:tool-result', (ev) => this._onToolResult(ev));
    }
    // Window-focus refresh: when the user tabs back into the app,
    // re-read the root. Catches changes made by external editors,
    // git operations, etc. Throttled to one refresh per second so
    // rapid focus/blur doesn't hammer fs.
    this._onFocus = () => this._maybeRefreshOnFocus();
    window.addEventListener('focus', this._onFocus);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubTool?.();
    if (this._onFocus) window.removeEventListener('focus', this._onFocus);
  }

  /** Worker tool finished. If it mutated files, refresh the affected
   *  directory's listing. Two paths:
   *
   *   - Path-shaped tools (write_file, edit): resolve the arg against
   *     the tree root, walk up to the nearest cached ancestor, reload.
   *   - bash: we can't parse arbitrary shell, so we don't try. Instead
   *     we re-list every currently-expanded folder. Costs one IPC per
   *     expanded folder; in practice that's a handful, not hundreds.
   */
  _onToolResult(ev) {
    if (!this._root) return;
    if (!ev || !ev.call || ev.result?.ok === false) return;
    if (ev.call.name === 'bash') {
      this._refreshAllExpanded();
      return;
    }
    const raw = affectedPath(ev.call);
    if (!raw) return;
    const abs = isAbsolute(raw) ? raw : joinPath(this._root, raw);
    if (!isUnder(abs, this._root)) return;
    let dir = parentDir(abs);
    while (dir && dir.length >= this._root.length) {
      if (this._tree.has(dir)) {
        const existing = this._tree.get(dir);
        this._tree.forget(dir);
        void this._loadChildren(dir, !!existing?.expanded);
        return;
      }
      if (dir === this._root) break;
      const next = parentDir(dir);
      if (next === dir) break;
      dir = next;
    }
  }

  /** Re-list every expanded folder. Used after bash since we can't
   *  tell what (if anything) it touched. Preserves expanded state
   *  for each folder. Children that no longer exist get dropped from
   *  the cache so the next render doesn't show ghost entries. */
  _refreshAllExpanded() {
    const paths = [];
    for (const [path, state] of this._tree.byPath) {
      if (state && state.expanded) paths.push(path);
    }
    if (paths.length === 0) {
      // Nothing expanded — at least refresh the root so the user sees
      // new top-level entries / deletions.
      if (this._tree.has(this._root)) paths.push(this._root);
    }
    for (const p of paths) {
      const existing = this._tree.get(p);
      this._tree.forget(p);
      // Also drop cached children of `p` whose parents went away. We
      // don't know yet which they are; the next render only walks from
      // currently-expanded entries, so stale cache entries are harmless
      // until their parent re-expands. Leaving them avoids a full
      // recursive wipe + reload.
      void this._loadChildren(p, !!existing?.expanded);
    }
  }

  async _maybeRefreshOnFocus() {
    const now = Date.now();
    if (this._lastFocusRefresh && (now - this._lastFocusRefresh) < 1000) return;
    this._lastFocusRefresh = now;
    if (!this._root) return;
    // Refresh just the root for now — recursively refreshing every
    // expanded folder could chain a lot of IPC calls. Children get
    // refreshed via the tool-result hook when *we* touch them.
    this._tree.forget(this._root);
    await this._loadChildren(this._root, true);
  }

  async _hydrate() {
    try {
      const t = transport();
      const openR = await t?.settings?.get?.('fileTreeOpen', false);
      const hiddenR = await t?.settings?.get?.('fileTreeShowHidden', false);
      if (openR && openR.value === true) this.open = true;
      if (hiddenR && hiddenR.value === true) this.showHidden = true;
    } catch { /* defaults are fine */ }
    if (this.open) await this._initRoot();
  }

  /** Resolve the initial root and load its children. Called when the
   *  tree is opened (either via setProperty or hydrate). Prefers the
   *  user's chosen editorRoot (set by the change-root button) over
   *  the first scope root, which can be sorted unpredictably once
   *  multiple roots exist. Idempotent. */
  async _initRoot() {
    const t = transport();
    if (!t?.fs?.scopeList) {
      this._root = '';
      return;
    }
    this._rootLoading = true;
    try {
      // Try the persisted editorRoot first.
      let chosen = '';
      try {
        const r = await t.settings?.get?.('editorRoot', null);
        if (r && typeof r.value === 'string' && r.value) chosen = r.value;
      } catch { /* fall through to scope */ }
      if (!chosen) {
        const r = await t.fs.scopeList();
        const roots = (r && r.ok && Array.isArray(r.roots)) ? r.roots : [];
        chosen = roots[0] || '';
      }
      this._root = chosen;
      if (this._root) await this._loadChildren(this._root, /*expand=*/true);
    } finally {
      this._rootLoading = false;
      this._bump();
    }
  }

  /** Change-root button: native dir picker → persist editorRoot →
   *  add to scope (so fs:* IPC accepts it) → reload tree. */
  async _onChangeRoot() {
    const t = transport();
    if (!t?.dialog?.chooseDirectory || !t?.editor?.setRoot) return;
    let chosen;
    try {
      const res = await t.dialog.chooseDirectory({
        title: 'Choose editor root',
        defaultPath: this._root || undefined,
      });
      if (!res || res.canceled || !res.path) return;
      chosen = res.path;
    } catch { return; }
    try {
      const r = await t.editor.setRoot(chosen);
      if (!r || !r.ok) return;
      this._root = r.root || chosen;
    } catch { return; }
    this._tree.clear();
    this._rootLoading = true;
    try {
      await this._loadChildren(this._root, /*expand=*/true);
    } finally {
      this._rootLoading = false;
      this._bump();
    }
  }

  /** Load + cache the children of a folder. Marks the folder as
   *  expanded if `expand` is true (default) — that's the standard
   *  "click a folder to open it" behavior. */
  async _loadChildren(path, expand = true) {
    const existing = this._tree.get(path);
    if (existing && existing.entries && existing.entries.length >= 0 && !existing.error) {
      // Already loaded successfully — just toggle expansion. (Don't
      // short-circuit when entries[] is empty + we have an error; we
      // want a real reload to clear the error if the dir is back.)
      if (expand !== undefined) existing.expanded = expand;
      this._bump();
      return;
    }
    this._tree.set(path, { entries: [], expanded: !!expand, loading: true, error: null });
    this._bump();
    try {
      const t = transport();
      const r = await t.fs.listDir(path, { showHidden: this.showHidden });
      if (r && r.ok && Array.isArray(r.entries)) {
        this._tree.set(path, { entries: r.entries, expanded: !!expand, loading: false, error: null });
      } else if (r && isMissingError(r.error)) {
        // Directory no longer exists (deleted by a bash command etc.).
        // Drop the cache entry entirely; parent's listing will reflect
        // the absence on its next reload.
        this._tree.forget(path);
      } else {
        this._tree.set(path, {
          entries: [], expanded: !!expand, loading: false,
          error: (r && r.error) || 'failed to list directory',
        });
      }
    } catch (err) {
      const msg = err?.message || String(err);
      if (isMissingError(msg)) {
        this._tree.forget(path);
      } else {
        this._tree.set(path, {
          entries: [], expanded: !!expand, loading: false, error: msg,
        });
      }
    }
    this._bump();
  }

  /** Toggle expand/collapse for a folder. First click loads children. */
  _onFolderClick(path) {
    const existing = this._tree.get(path);
    if (!existing) {
      void this._loadChildren(path, true);
      return;
    }
    existing.expanded = !existing.expanded;
    this._bump();
  }

  /** File click: dispatch file-open. renderer.js routes it to an inline
   *  tab or a separate editor window per the editorOpenMode setting. */
  _onFileClick(path) {
    this._dispatchOpen('file-open', path);
  }

  _dispatchOpen(/** @type {string} */ name, /** @type {string} */ path) {
    if (!path) return;
    this.dispatchEvent(new CustomEvent(name, {
      detail: { path }, bubbles: true, composed: true,
    }));
  }

  /** Context-menu "Open" — honors the editorOpenMode setting (same as a
   *  plain left-click). */
  _onOpenFile(ctx) {
    this._closeContextMenu();
    this._dispatchOpen('file-open', ctx?.path);
  }

  /** Context-menu override: always open in a separate editor window. */
  _onOpenFileInWindow(ctx) {
    this._closeContextMenu();
    this._dispatchOpen('file-open-window', ctx?.path);
  }

  /** Context-menu override: always open as an inline tab. */
  _onOpenFileInTab(ctx) {
    this._closeContextMenu();
    this._dispatchOpen('file-open-tab', ctx?.path);
  }

  /** Manual refresh button — drops the cache and reloads the root. */
  async _onRefresh() {
    this._tree.clear();
    await this._initRoot();
  }

  /** Right-click a row: open the context menu at the cursor. */
  _onContextMenu(ev, path, type, name) {
    ev.preventDefault();
    ev.stopPropagation();
    // Clamp into the viewport so the menu doesn't open off-screen near edges.
    const x = Math.min(ev.clientX, window.innerWidth - 180);
    const y = Math.min(ev.clientY, window.innerHeight - 90);
    this._ctx = { path, type, name, x: Math.max(4, x), y: Math.max(4, y) };
  }

  _closeContextMenu() { this._ctx = null; }

  /** Promise-based replacement for window.prompt() (which Electron disables).
   *  Renders an inline text input in the shadow DOM anchored near the cursor;
   *  resolves to the entered string, or null if cancelled (Esc / blur / empty).
   *  @param {{ title: string, value?: string, placeholder?: string, x: number, y: number }} opts
   *  @returns {Promise<string|null>} */
  _askName({ title, value = '', placeholder = '', x, y }) {
    // Only one prompt at a time — cancel any in flight.
    if (this._prompt) this._prompt.resolve(null);
    return new Promise((resolve) => {
      this._prompt = {
        title,
        value,
        placeholder,
        x: Math.max(4, Math.min(x, window.innerWidth - 240)),
        y: Math.max(4, Math.min(y, window.innerHeight - 90)),
        resolve: (/** @type {string|null} */ result) => {
          this._prompt = null;
          resolve(result);
        },
      };
    });
  }

  _submitPrompt(/** @type {Event} */ ev) {
    ev?.preventDefault?.();
    const p = this._prompt;
    if (!p) return;
    const input = /** @type {HTMLInputElement|null} */ (this.renderRoot?.querySelector('.np-input'));
    const val = input ? input.value : p.value;
    p.resolve(val);
  }

  _cancelPrompt() { this._prompt?.resolve(null); }

  /** Delete (to OS trash) the context-menu target, then reload its parent
   *  folder so the row disappears. Confirms first — destructive + recursive
   *  for directories. */
  async _onDelete(ctx) {
    this._closeContextMenu();
    if (!ctx || !ctx.path) return;
    const what = ctx.type === 'dir' ? `folder "${ctx.name}" and everything in it` : `"${ctx.name}"`;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Move ${what} to the trash?`)) return;

    let res;
    try {
      res = await transport()?.fs?.deleteFile?.(ctx.path);
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    if (!res || !res.ok) {
      const reason = (res && (res.error || res.reason)) || 'delete failed';
      // eslint-disable-next-line no-alert
      window.alert(`Could not delete ${ctx.name}: ${reason}`);
      return;
    }
    // Tell the editor a path went away (so an open tab for it can close).
    this.dispatchEvent(new CustomEvent('file-deleted', {
      detail: { path: ctx.path, type: ctx.type },
      bubbles: true,
      composed: true,
    }));
    // Reload the parent dir so the deleted entry drops out of the tree.
    const parent = parentDir(ctx.path);
    if (parent && this._tree.has(parent)) {
      const existing = this._tree.get(parent);
      this._tree.forget(parent);
      await this._loadChildren(parent, !!existing?.expanded);
    } else {
      await this._onRefresh();
    }
  }

  /** Reload whichever cached folder is `dir`'s contents, or fall back to a
   *  full refresh if `dir` was never loaded (e.g. it was the empty root). */
  async _reloadDir(dir) {
    if (dir && this._tree.has(dir)) {
      const existing = this._tree.get(dir);
      this._tree.forget(dir);
      await this._loadChildren(dir, !!existing?.expanded);
    } else {
      await this._onRefresh();
    }
  }

  /** Create a new folder inside ctx's directory (ctx.path itself if it's a
   *  dir, otherwise its parent), prompting for a name. */
  async _onNewFolder(ctx) {
    const dir = ctx && ctx.type === 'dir' ? ctx.path : (ctx ? parentDir(ctx.path) : this._root);
    const anchor = ctx ? { x: ctx.x, y: ctx.y } : { x: 12, y: 12 };
    this._closeContextMenu();
    if (!dir) return;
    const name = await this._askName({ title: 'New folder name', placeholder: 'folder name', ...anchor });
    if (!name) return;
    if (!isSafeEntryName(name)) {
      // eslint-disable-next-line no-alert
      window.alert(`"${name}" is not a valid folder name.`);
      return;
    }
    const target = joinPath(dir, name);
    const res = await transport()?.fs?.createDir?.(target);
    if (!res || !res.ok) {
      // eslint-disable-next-line no-alert
      window.alert(`Could not create folder: ${(res && (res.error || res.reason)) || 'failed'}`);
      return;
    }
    await this._reloadDir(dir);
  }

  /** Create a new empty file inside ctx's directory, prompting for a name. */
  async _onNewFile(ctx) {
    const dir = ctx && ctx.type === 'dir' ? ctx.path : (ctx ? parentDir(ctx.path) : this._root);
    const anchor = ctx ? { x: ctx.x, y: ctx.y } : { x: 12, y: 12 };
    this._closeContextMenu();
    if (!dir) return;
    const name = await this._askName({ title: 'New file name', placeholder: 'file name', ...anchor });
    if (!name) return;
    if (!isSafeEntryName(name)) {
      // eslint-disable-next-line no-alert
      window.alert(`"${name}" is not a valid file name.`);
      return;
    }
    const target = joinPath(dir, name);
    const res = await transport()?.fs?.writeFile?.(target, '');
    if (!res || !res.ok) {
      // eslint-disable-next-line no-alert
      window.alert(`Could not create file: ${(res && (res.error || res.reason)) || 'failed'}`);
      return;
    }
    await this._reloadDir(dir);
  }

  /** Rename/move the context-menu target within its current parent folder. */
  async _onRename(ctx) {
    const anchor = ctx ? { x: ctx.x, y: ctx.y } : { x: 12, y: 12 };
    this._closeContextMenu();
    if (!ctx || !ctx.path) return;
    const name = await this._askName({
      title: `Rename "${ctx.name}" to`, value: ctx.name, ...anchor,
    });
    if (!name || name === ctx.name) return;
    if (!isSafeEntryName(name)) {
      // eslint-disable-next-line no-alert
      window.alert(`"${name}" is not a valid name.`);
      return;
    }
    const parent = parentDir(ctx.path);
    if (!parent) return;
    const newPath = joinPath(parent, name);
    const res = await transport()?.fs?.rename?.(ctx.path, newPath);
    if (!res || !res.ok) {
      // eslint-disable-next-line no-alert
      window.alert(`Could not rename ${ctx.name}: ${(res && (res.error || res.reason)) || 'failed'}`);
      return;
    }
    this.dispatchEvent(new CustomEvent('file-renamed', {
      detail: { path: ctx.path, newPath, type: ctx.type },
      bubbles: true,
      composed: true,
    }));
    await this._reloadDir(parent);
  }

  async _onToggleHidden() {
    this.showHidden = !this.showHidden;
    try { await transport()?.settings?.set?.('fileTreeShowHidden', this.showHidden); }
    catch { /* ignore */ }
    // showHidden affects the contents of every folder we've already
    // loaded, so blow the cache and reload the root.
    this._tree.clear();
    await this._initRoot();
  }

  /** Public API for the topbar Files toggle. */
  async setOpen(/** @type {boolean} */ on) {
    const next = !!on;
    if (this.open === next) return;
    this.open = next;
    try { await transport()?.settings?.set?.('fileTreeOpen', next); }
    catch { /* ignore */ }
    if (next && !this._root) await this._initRoot();
  }

  _bump() { this._tick = (this._tick + 1) | 0; }

  updated(changed) {
    // Focus + select the inline-prompt input the moment it appears, so the
    // user can type a name immediately (mirrors native prompt() behaviour).
    if (changed.has('_prompt') && this._prompt) {
      const input = /** @type {HTMLInputElement|null} */ (this.renderRoot?.querySelector('.np-input'));
      if (input) { input.focus(); input.select(); }
    }
  }

  // --- rendering --------------------------------------------------------

  render() {
    return html`
      <div class="header">
        <span class="title" title=${this._root || ''}>${shortenRoot(this._root) || 'Files'}</span>
        <button class="icon-btn" type="button"
                id="ft-change-root"
                title="Change root directory"
                @click=${this._onChangeRoot}>📁</button>
        <button class="icon-btn" type="button"
                title="Show hidden files (node_modules, .git, dist, .myagent)"
                aria-pressed=${this.showHidden}
                @click=${this._onToggleHidden}>•••</button>
        <button class="icon-btn" type="button"
                title="Refresh"
                @click=${this._onRefresh}>↻</button>
      </div>
      <div class="body" id="ft-body"
           @contextmenu=${(/** @type {MouseEvent} */ ev) => this._onBodyContextMenu(ev)}>
        ${this._renderTreeBody()}
      </div>
      ${this._renderContextMenu()}
      ${this._renderPrompt()}
    `;
  }

  /** Right-click on empty body space (not a row) targets the root folder —
   *  lets "New folder"/"New file" work even with nothing under the cursor.
   *  Row-level contextmenu handlers call stopPropagation, so this only
   *  fires when the click actually missed every row. */
  _onBodyContextMenu(ev) {
    if (!this._root) return;
    this._onContextMenu(ev, this._root, 'dir', shortenRoot(this._root) || this._root);
  }

  _renderContextMenu() {
    const ctx = this._ctx;
    if (!ctx) return '';
    const label = ctx.type === 'dir' ? 'folder' : 'file';
    // A right-click on empty body space targets the root as a stand-in
    // "current folder" — rename/delete don't make sense against it.
    const isRootStandIn = ctx.path === this._root;
    return html`
      <div class="ctx-backdrop" @click=${this._closeContextMenu}
           @contextmenu=${(/** @type {Event} */ e) => { e.preventDefault(); this._closeContextMenu(); }}></div>
      <div class="ctx-menu" style=${`left:${ctx.x}px; top:${ctx.y}px;`} role="menu">
        <div class="ctx-title" title=${ctx.path}>${ctx.name}</div>
        ${ctx.type === 'file' ? html`
          <button class="ctx-item" type="button" role="menuitem"
                  @click=${() => this._onOpenFile(ctx)}>
            Open
          </button>
          <button class="ctx-item" type="button" role="menuitem"
                  @click=${() => this._onOpenFileInWindow(ctx)}>
            Open in new window
          </button>
          <button class="ctx-item" type="button" role="menuitem"
                  @click=${() => this._onOpenFileInTab(ctx)}>
            Open in tab
          </button>
          <div class="ctx-sep" role="separator"></div>
        ` : ''}
        <button class="ctx-item" type="button" role="menuitem"
                @click=${() => this._onNewFolder(ctx)}>
          New folder…
        </button>
        <button class="ctx-item" type="button" role="menuitem"
                @click=${() => this._onNewFile(ctx)}>
          New file…
        </button>
        ${isRootStandIn ? '' : html`
          <button class="ctx-item" type="button" role="menuitem"
                  @click=${() => this._onRename(ctx)}>
            Rename ${label}…
          </button>
          <button class="ctx-item ctx-danger" type="button" role="menuitem"
                  @click=${() => this._onDelete(ctx)}>
            Delete ${label}…
          </button>
        `}
      </div>
    `;
  }

  /** Inline name-prompt overlay — our window.prompt() replacement, since
   *  Electron throws "prompt() is not supported". Auto-focuses + selects on
   *  first render; Enter submits, Esc / outside-click cancels. */
  _renderPrompt() {
    const p = this._prompt;
    if (!p) return '';
    return html`
      <div class="np-backdrop" @click=${this._cancelPrompt}
           @contextmenu=${(/** @type {Event} */ e) => { e.preventDefault(); this._cancelPrompt(); }}></div>
      <form class="np-box" style=${`left:${p.x}px; top:${p.y}px;`}
            @submit=${(/** @type {Event} */ e) => this._submitPrompt(e)}>
        <div class="np-title">${p.title}</div>
        <input class="np-input" type="text" .value=${p.value} placeholder=${p.placeholder}
               spellcheck="false" autocomplete="off"
               @keydown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); this._cancelPrompt(); } }} />
        <div class="np-actions">
          <button class="np-btn" type="button" @click=${this._cancelPrompt}>Cancel</button>
          <button class="np-btn np-ok" type="submit">OK</button>
        </div>
      </form>
    `;
  }

  _renderTreeBody() {
    if (!this._root) {
      return html`<div class="empty">${this._rootLoading ? 'loading…' : 'no scope'}</div>`;
    }
    const root = this._tree.get(this._root);
    if (!root) {
      return html`<div class="empty">${this._rootLoading ? 'loading…' : ''}</div>`;
    }
    return this._renderEntries(this._root, root, 0);
  }

  /**
   * @param {string} parentPath
   * @param {{entries: any[], expanded: boolean, loading: boolean, error: string|null}} state
   * @param {number} depth
   */
  _renderEntries(parentPath, state, depth) {
    if (state.loading) {
      return html`<div class="row is-loading" style=${indentStyle(depth)}>
        <span class="twisty twisty--placeholder">·</span>
        <span class="icon">…</span>
        <span class="name">loading…</span>
      </div>`;
    }
    if (state.error) {
      return html`<div class="row is-error" style=${indentStyle(depth)} title=${state.error}>
        <span class="twisty twisty--placeholder">·</span>
        <span class="icon">!</span>
        <span class="name">${state.error}</span>
      </div>`;
    }
    if (state.entries.length === 0) {
      return html`<div class="row is-loading" style=${indentStyle(depth)}>
        <span class="twisty twisty--placeholder">·</span>
        <span class="icon">·</span>
        <span class="name">(empty)</span>
      </div>`;
    }
    return state.entries.map((e) => this._renderEntry(parentPath, e, depth));
  }

  /**
   * @param {string} parentPath
   * @param {{ name: string, type: 'dir'|'file'|'symlink', size?: number, mtime?: number }} e
   * @param {number} depth
   */
  _renderEntry(parentPath, e, depth) {
    const childPath = joinPath(parentPath, e.name);
    if (e.type === 'dir') {
      const sub = this._tree.get(childPath);
      const expanded = !!(sub && sub.expanded);
      const tw = expanded ? '▾' : '▸';
      return html`
        <div class="row" style=${indentStyle(depth)}
             @click=${() => this._onFolderClick(childPath)}
             @contextmenu=${(/** @type {MouseEvent} */ ev) => this._onContextMenu(ev, childPath, 'dir', e.name)}
             title=${childPath}>
          <span class="twisty">${tw}</span>
          <span class="icon icon--folder">▣</span>
          <span class="name">${e.name}</span>
        </div>
        ${expanded && sub
          ? this._renderEntries(childPath, sub, depth + 1)
          : ''}
      `;
    }
    // File / symlink — leaf node.
    return html`
      <div class="row" style=${indentStyle(depth)}
           @click=${() => this._onFileClick(childPath)}
           @contextmenu=${(/** @type {MouseEvent} */ ev) => this._onContextMenu(ev, childPath, e.type, e.name)}
           title=${childPath}>
        <span class="twisty twisty--placeholder">·</span>
        <span class="icon icon--file">·</span>
        <span class="name">${e.name}</span>
      </div>
    `;
  }
}

// --- helpers ----------------------------------------------------------

/** A user-typed new/rename name must be a single path segment — no
 *  separators, no "." / "..", nothing that could escape the target
 *  directory. The IPC handlers are scope-gated independently, but this
 *  keeps obviously-wrong input from ever leaving the renderer. */
function isSafeEntryName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (/[\\/]/.test(trimmed)) return false;
  return true;
}

function indentStyle(depth) {
  // 12px per depth — enough to make the structure obvious without
  // chewing up horizontal space at deep nesting.
  return `padding-left: ${8 + depth * 12}px;`;
}

function joinPath(a, b) {
  if (!a) return b;
  // Detect Windows-style path. We must keep the original separator
  // style or Scope.contains() (which is platform-correct) will mismatch.
  const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/';
  if (a.endsWith(sep)) return a + b;
  return a + sep + b;
}

function shortenRoot(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

/** Map a chat:tool-result call to the path that changed. Returns the
 *  raw arg string (caller resolves vs root + walks up to cached
 *  ancestor). Returns null for tools that don't mutate the fs. Bash
 *  is excluded — parsing arbitrary shell commands is its own project. */
function affectedPath(call) {
  if (!call || !call.name) return null;
  const args = call.arguments || {};
  const PATH_KEYS = {
    write_file: 'path',
    edit: 'file_path',
    delete_file: 'path',
    move_file: 'to',
    create_directory: 'path',
    mkdir: 'path',
  };
  const key = PATH_KEYS[call.name];
  if (!key) return null;
  const p = args[key];
  if (typeof p !== 'string' || !p) return null;
  return p;
}

function parentDir(p) {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const i = p.lastIndexOf(sep);
  if (i <= 0) return null;
  return p.slice(0, i);
}

/** Windows: starts with drive letter (`C:\`) or UNC (`\\server\`).
 *  POSIX: starts with `/`. */
function isAbsolute(p) {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  return false;
}

/** Heuristic: does this error string indicate the path no longer exists?
 *  Covers Node's ENOENT and the human-readable forms a few wrappers emit.
 *  When true the cache entry is dropped instead of shown as "error".
 *  Conservative — false-positives just leave an error row, which is
 *  the old behavior; false-negatives turn a real error into silence. */
function isMissingError(msg) {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  return s.includes('enoent')
    || s.includes('no such file')
    || s.includes('cannot find the path')
    || s.includes('cannot find the file')
    || s.includes('not found');
}

/** True if `child` is the same path as or nested under `parent`.
 *  Case-insensitive on Windows-style paths (drive letters). */
function isUnder(child, parent) {
  if (!child || !parent) return false;
  const isWin = /^[A-Za-z]:[\\/]/.test(parent) || parent.includes('\\');
  const norm = (s) => isWin ? s.toLowerCase().replace(/\\/g, '/') : s;
  const c = norm(child);
  const p = norm(parent.replace(/[\\/]+$/, ''));
  if (c === p) return true;
  return c.startsWith(p + '/');
}

customElements.define('file-tree', FileTree);
// Exported for unit tests; not part of the component's public API.
export const _internals = { affectedPath, parentDir, isAbsolute, isUnder, joinPath, isMissingError };
