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
  `;

  constructor() {
    super();
    this.open = false;
    this.showHidden = false;
    this._root = '';
    this._tick = 0;
    this._rootLoading = false;
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
   *  tree is opened (either via setProperty or hydrate). Idempotent:
   *  re-running after a refresh just rereads the same root. */
  async _initRoot() {
    const t = transport();
    if (!t?.fs?.scopeList) {
      this._root = '';
      return;
    }
    this._rootLoading = true;
    try {
      const r = await t.fs.scopeList();
      const roots = (r && r.ok && Array.isArray(r.roots)) ? r.roots : [];
      this._root = roots[0] || '';
      if (this._root) await this._loadChildren(this._root, /*expand=*/true);
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
    if (existing && existing.entries) {
      // Already loaded — just toggle expansion.
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
      } else {
        this._tree.set(path, {
          entries: [], expanded: !!expand, loading: false,
          error: (r && r.error) || 'failed to list directory',
        });
      }
    } catch (err) {
      this._tree.set(path, {
        entries: [], expanded: !!expand, loading: false,
        error: err?.message || String(err),
      });
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

  /** File click: dispatch file-open. Phase 3 wires this to a tab. */
  _onFileClick(path) {
    this.dispatchEvent(new CustomEvent('file-open', {
      detail: { path },
      bubbles: true,
      composed: true,
    }));
  }

  /** Manual refresh button — drops the cache and reloads the root. */
  async _onRefresh() {
    this._tree.clear();
    await this._initRoot();
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

  // --- rendering --------------------------------------------------------

  render() {
    return html`
      <div class="header">
        <span class="title" title=${this._root || ''}>${shortenRoot(this._root) || 'Files'}</span>
        <button class="icon-btn" type="button"
                title="Show hidden files (node_modules, .git, dist, .myagent)"
                aria-pressed=${this.showHidden}
                @click=${this._onToggleHidden}>•••</button>
        <button class="icon-btn" type="button"
                title="Refresh"
                @click=${this._onRefresh}>↻</button>
      </div>
      <div class="body" id="ft-body">
        ${this._renderTreeBody()}
      </div>
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
           title=${childPath}>
        <span class="twisty twisty--placeholder">·</span>
        <span class="icon icon--file">·</span>
        <span class="name">${e.name}</span>
      </div>
    `;
  }
}

// --- helpers ----------------------------------------------------------

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

customElements.define('file-tree', FileTree);
