// @ts-check
// <file-tabs> — VS-Code-style tab strip for the editor BrowserWindow.
// Each tab corresponds to an open file. Clicking selects, the × closes.
// No dirty marker / lock icon yet (those land in Phase 4).
//
// State is OWNED HERE: the parent (file-editor) reads `tabs` and
// `activePath` and renders the matching buffer. We expose imperative
// methods (open, close, activate) so the host can drive it from
// editor:load-file events without round-tripping through attributes.
//
// Events emitted (bubbles, composed):
//   - tab-activate    { detail: { path } }  — user clicked a tab
//   - tab-close       { detail: { path } }  — user clicked ×
//   - tab-toggle-lock { detail: { path } }  — user clicked the lock icon
//
// Shadow-DOM Lit element per the existing sidebar-widget convention.

import { LitElement, html, css } from 'lit';

export class FileTabs extends LitElement {
  static properties = {
    /** Array of { path, name, dirty?, locked? } in display order. */
    tabs: { state: true },
    /** Path of the currently-active tab, or '' if none. */
    activePath: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex: 0 0 auto;
      overflow-x: auto;
      overflow-y: hidden;
      background: var(--surface-2, #2a2a2a);
      border-bottom: 1px solid var(--border, #404040);
      font-size: 12px;
      color: var(--text, #dcdcdc);
      font-family: 'Cascadia Code', Consolas, Menlo, monospace;
      user-select: none;
    }
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px 6px 10px;
      border-right: 1px solid var(--border, #404040);
      cursor: pointer;
      max-width: 240px;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .tab:hover { background: var(--surface-3, #333); }
    .tab.is-active {
      background: var(--bg, #1e1e1e);
      color: var(--accent-fg, #fff);
    }
    .tab__name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tab__close, .tab__lock {
      flex: 0 0 auto;
      background: transparent;
      border: none;
      color: var(--text-dim, #888);
      cursor: pointer;
      padding: 0 4px;
      font: inherit;
      font-size: 12px;
      border-radius: 3px;
    }
    .tab__close:hover { background: var(--warn-bg, #4a3030); color: var(--warn, #f88); }
    .tab__lock:hover  { background: var(--surface-3, #333); color: var(--text, #dcdcdc); }
    .tab__lock.is-locked { color: var(--accent-fg, #d4a14a); }
    .tab__dirty {
      flex: 0 0 auto;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-fg, #d4a14a);
    }
    .tab__dirty--placeholder { background: transparent; }
    .empty {
      padding: 6px 10px;
      color: var(--text-faint, #666);
      font-style: italic;
    }
  `;

  constructor() {
    super();
    /** @type {Array<{ path: string, name: string, dirty?: boolean, locked?: boolean }>} */
    this.tabs = [];
    this.activePath = '';
  }

  // --- imperative API used by file-editor host -----------------------

  /** Open a file (or focus its existing tab). Returns the active path. */
  open(/** @type {string} */ path) {
    if (!path) return this.activePath;
    const existing = this.tabs.find((t) => t.path === path);
    if (!existing) {
      this.tabs = [...this.tabs, { path, name: basename(path), dirty: false, locked: false }];
    }
    this.activePath = path;
    return this.activePath;
  }

  /** Update per-tab metadata (dirty, locked). Triggers a re-render. */
  setTabState(/** @type {string} */ path, /** @type {object} */ patch) {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const next = this.tabs.slice();
    next[idx] = { ...next[idx], ...patch };
    this.tabs = next;
  }

  /** Lookup a tab's metadata. Returns undefined if not open. */
  getTab(/** @type {string} */ path) {
    return this.tabs.find((t) => t.path === path);
  }

  /** Close a tab. If it was active, activates the previous tab (or ''). */
  close(/** @type {string} */ path) {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const wasActive = this.activePath === path;
    const next = this.tabs.filter((t) => t.path !== path);
    this.tabs = next;
    if (wasActive) {
      const fallback = next[idx - 1] || next[0] || null;
      this.activePath = fallback ? fallback.path : '';
    }
  }

  /** @param {string} path */
  activate(path) {
    if (this.tabs.some((t) => t.path === path)) this.activePath = path;
  }

  // --- rendering ------------------------------------------------------

  render() {
    if (this.tabs.length === 0) {
      return html`<div class="empty">no files open</div>`;
    }
    return this.tabs.map((t) => html`
      <div class="tab ${this.activePath === t.path ? 'is-active' : ''}"
           title=${t.path}
           @click=${() => this._onSelect(t.path)}>
        <button class="tab__lock ${t.locked ? 'is-locked' : ''}" type="button"
                title=${t.locked ? 'Locked: save refuses if file changed on disk' : 'Unlocked: save overwrites'}
                @click=${(e) => this._onToggleLock(e, t.path)}>${t.locked ? '🔒' : '🔓'}</button>
        <span class="tab__name">${t.name}</span>
        <span class="tab__dirty ${t.dirty ? '' : 'tab__dirty--placeholder'}"
              title=${t.dirty ? 'unsaved changes' : ''}></span>
        <button class="tab__close" type="button"
                title="Close"
                @click=${(e) => this._onClose(e, t.path)}>×</button>
      </div>
    `);
  }

  _onSelect(path) {
    if (this.activePath === path) return;
    this.activePath = path;
    this.dispatchEvent(new CustomEvent('tab-activate', {
      detail: { path }, bubbles: true, composed: true,
    }));
  }

  _onClose(ev, path) {
    ev.stopPropagation();
    this.dispatchEvent(new CustomEvent('tab-close', {
      detail: { path }, bubbles: true, composed: true,
    }));
  }

  _onToggleLock(ev, path) {
    ev.stopPropagation();
    this.dispatchEvent(new CustomEvent('tab-toggle-lock', {
      detail: { path }, bubbles: true, composed: true,
    }));
  }
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

customElements.define('file-tabs', FileTabs);
