// @ts-check
// <settings-drawer> — the gear-icon panel. All knobs the chat surface
// exposes live here:
//   - Mirror toggles (default + auto-context)
//   - Chat side picker (Left | Right) — persisted via transport.settings
//   - Tool details mode (Expanded | Collapsed | Hidden) — persisted
//   - Workers section: spawn buttons + cwd picker + per-worker rows
//
// Reads the relevant slices from the store. Mutations route through
// renderer/state/actions.js where possible. The drawer dispatches
// minimal events to the parent — `spawn` (kind) for the workers
// section, mirroring the empty-state contract.
//
// Visibility is controlled by an `open` boolean property (reflected as
// the [open] attribute). Parent toggles it; the drawer animates via
// CSS transitions on max-height/opacity. Persists no UI state of its
// own — nothing to lose on remount.

import { LitElement, html, css } from 'lit';
import { store } from '../state/store.js';
import {
  pickCwd, closeWorker, renameWorker, refreshWorkers,
  setWorkerMirror, setDefaultMirror,
  getSetting, setSetting, hydrateLastCwd,
} from '../state/actions.js';
import { cmdBtnStyles } from './styles.js';

/** @returns {any} */
function transport() { return /** @type {any} */ (window).transport; }

function shortenPath(/** @type {string|null|undefined} */ p) {
  if (!p) return '(repo root)';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

export class SettingsDrawer extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    /** Available Ollama Cloud models (from main via .env). */
    _ollamaModels: { state: true },
    /** Currently-selected Ollama Cloud model in the spawn dropdown. */
    _ollamaModel: { state: true },
    /** Auto-context memory match threshold (0-1). Higher = stricter. */
    _autoContextMinConfidence: { state: true },
  };

  static styles = [
    cmdBtnStyles,
    css`
      :host {
        flex: 0 0 auto;
        display: block;
        background: var(--surface-2);
        border-bottom: 1px solid var(--border);
        padding: 10px 14px;
        max-height: 280px;
        overflow-y: auto;
        transition: max-height 160ms ease, padding 160ms ease, opacity 160ms ease;
      }
      :host(:not([open])) {
        max-height: 0;
        padding-top: 0;
        padding-bottom: 0;
        opacity: 0;
        border-bottom-width: 0;
        overflow: hidden;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--text);
        padding: 4px 0;
        cursor: pointer;
        user-select: none;
      }
      .row input { margin: 0; }
      .row--slider { gap: 8px; }
      .row--slider input[type="range"] { flex: 1 1 auto; min-width: 0; cursor: pointer; }
      .row--slider input[type="range"]:disabled { opacity: 0.4; cursor: not-allowed; }
      .row--slider .slider-value {
        flex: 0 0 auto;
        min-width: 2.5em;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--text-dim, var(--text));
      }
      .row--header {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
        cursor: default;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-dim);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .spawn-buttons { display: inline-flex; gap: 4px; flex-wrap: wrap; align-items: center; }
      .am-select--inline {
        flex: 0 0 auto;
        max-width: 160px;
        font-size: 10px;
        padding: 2px 4px;
      }
      .row--cwd { margin-top: 4px; padding-bottom: 8px; gap: 8px; }
      .label--small {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-dim);
        flex: 0 0 auto;
      }
      .cwd-button {
        background: transparent;
        border: 1px dashed var(--border);
        border-radius: 4px;
        color: var(--text-dim);
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        font-size: 11px;
        padding: 3px 8px;
        cursor: pointer;
        flex: 1 1 auto;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: border-color 80ms ease, color 80ms ease;
      }
      .cwd-button:hover {
        border-color: var(--accent);
        color: var(--text);
      }
      .row--device { gap: 8px; }
      .row--device-status {
        margin-top: -4px;
        padding-bottom: 8px;
        font-size: 10px;
        color: var(--text-faint);
      }
      .device-status--warn { color: var(--warn); }
      .am-select {
        flex: 1 1 auto;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 3px 6px;
        font: inherit;
        font-size: 11px;
      }
      .am-select:focus {
        outline: none;
        border-color: var(--accent);
      }
      .row--device-tools { gap: 6px; padding-bottom: 8px; }
      .row--device-tools .cmd-btn { flex: 0 0 auto; }
      .row--gen-model { gap: 8px; padding-top: 4px; }
      .row--explain { gap: 6px; padding-bottom: 6px; }
      .gen-model-info {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 6px 10px;
        margin: 0 0 6px 0;
        font-size: 11px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .gen-model-info[hidden] { display: none; }
      .gen-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .gen-row--actions { gap: 6px; padding-top: 2px; }
      .gen-label {
        flex: 0 0 auto;
        color: var(--text-faint);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        width: 56px;
      }
      .gen-link {
        color: var(--accent);
        text-decoration: none;
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1 1 auto;
        min-width: 0;
      }
      .gen-link:hover { text-decoration: underline; }
      .gen-cache { color: var(--text-dim); flex: 1 1 auto; }
      .gen-cache--ok      { color: #6bb56b; }
      .gen-cache--missing { color: var(--warn); }
      /* Segmented control (e.g. Left | Right) — two cmd-btns flush. */
      .segmented { display: inline-flex; }
      .segmented .cmd-btn { border-radius: 0; }
      .segmented .cmd-btn:first-child {
        border-top-left-radius: 3px;
        border-bottom-left-radius: 3px;
      }
      .segmented .cmd-btn:last-child {
        border-top-right-radius: 3px;
        border-bottom-right-radius: 3px;
        margin-left: -1px;
      }
      .worker-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        font-size: 11px;
      }
      .worker-row__name {
        flex: 1 1 auto;
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        color: var(--text);
      }
      .worker-row__name input {
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 2px 6px;
        font: inherit;
        width: 100%;
      }
      .worker-row__meta {
        font-size: 10px;
        color: var(--text-faint);
        flex: 0 0 auto;
      }
      .worker-row__cwd {
        font-size: 10px;
        color: var(--text-faint);
        font-family: 'Cascadia Code', monospace;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
      }
      .worker-row__mirror {
        display: inline-flex;
        gap: 4px;
        align-items: center;
        font-size: 11px;
        color: var(--text-dim);
        cursor: pointer;
      }
      .empty-workers {
        color: var(--text-faint);
        font-size: 11px;
        padding: 6px 0;
      }
      /* Per-worker scope chip strip (ADR-0008). */
      .worker-row__scopes {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        padding: 0 0 6px 12px;
        font-size: 10px;
        color: var(--text-dim);
      }
      .scope-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        font-size: 10px;
        color: var(--text-dim);
      }
      .scope-chip--fenced {
        border-color: var(--accent, #4a4a4a);
        color: var(--text);
      }
      .scope-chip--empty {
        color: var(--text-faint);
        font-style: italic;
        border-style: dashed;
      }
      .scope-chip__icon { font-size: 10px; }
      .scope-chip__path {
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .scope-chip__remove {
        background: transparent;
        border: none;
        color: var(--text-dim);
        cursor: pointer;
        padding: 0 2px;
        font: inherit;
        font-size: 11px;
        line-height: 1;
      }
      .scope-chip__remove:hover { color: var(--warn, #f88); }
    `,
  ];

  constructor() {
    super();
    /** @type {boolean} */
    this.open = false;
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
    /** @type {string} */
    this._chatSide = 'left';
    /** @type {boolean} */
    this._autoContext = true;
    /** @type {number} */
    this._autoContextMinConfidence = 0.35;
    /** @type {boolean} */
    this._autoFileContext = true;
    /** @type {string[]} */
    this._ollamaModels = [];
    /** @type {string} */
    this._ollamaModel = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => this.requestUpdate());
    this._hydrate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  /** Initial state load — mirror + side + auto-context + embedder + models. */
  async _hydrate() {
    try {
      const r = await transport().chat.getSettings();
      const s = store.get();
      store.update({
        settings: { ...s.settings, defaultMirror: !!r.defaultMirror },
      });
    } catch { /* ignore */ }
    this._chatSide = await getSetting('chatSide', 'left');
    // Apply the persisted chat side to #app-row so the layout flips
    // immediately on load, before the user opens settings.
    const row = document.getElementById('app-row');
    if (row) row.classList.toggle('app-row--chat-right', this._chatSide === 'right');
    this._autoContext = (await getSetting('autoContext', true)) !== false;
    {
      const mc = Number(await getSetting('autoContextMinConfidence', 0.35));
      this._autoContextMinConfidence = (Number.isFinite(mc) && mc >= 0 && mc <= 1) ? mc : 0.35;
    }
    this._autoFileContext = (await getSetting('autoFileContext', true)) !== false;
    // Hydrate the persisted toolDetails into the store so chat-bubble
    // and tool-card render with the right default mode.
    const td = await getSetting('toolDetails', 'collapsed');
    const toolDetails = (td === 'expanded' || td === 'hidden') ? td : 'collapsed';
    const ns = store.get();
    store.update({
      settings: { ...ns.settings, toolDetails },
    });
    // Restore the persisted lastCwd into pendingCwd so empty-state
    // and the cwd-picker label show the right path on launch.
    hydrateLastCwd();
    // Fetch the Ollama Cloud model list from .env (main process).
    // Failure leaves the dropdown hidden — the spawn button still
    // works, falling back to the env default model.
    try {
      const r = await transport().workers.ollamaCloudModels?.();
      if (r?.ok && Array.isArray(r.models) && r.models.length > 0) {
        this._ollamaModels = r.models;
        this._ollamaModel = r.default || r.models[0];
      }
    } catch { /* ignore */ }
    this.requestUpdate();
  }

  _onOllamaModelChange(/** @type {Event} */ ev) {
    const target = /** @type {HTMLSelectElement} */ (ev.target);
    this._ollamaModel = target.value;
  }

  // --- Section renderers --------------------------------------------------

  _renderMirrorRow() {
    const s = store.get();
    return html`
      <label class="row">
        <input id="am-default-mirror" type="checkbox"
               .checked=${!!s.settings.defaultMirror}
               @change=${(/** @type {any} */ e) => setDefaultMirror(e.target.checked)} />
        <span>Save chats to memory by default</span>
      </label>
      <label class="row" title="Before each prompt is sent to a worker, search memory for relevant past context and prepend it.">
        <input id="am-auto-context" type="checkbox"
               .checked=${this._autoContext}
               @change=${async (/** @type {any} */ e) => {
                 this._autoContext = !!e.target.checked;
                 await setSetting('autoContext', this._autoContext);
               }} />
        <span>Auto-include relevant memories</span>
      </label>
      <label class="row row--slider"
             title="Minimum match score (0–1) a past memory must reach to be auto-included. Lower = recall more loosely related memories (more context, more noise). Higher = only near-identical past chats. Typical: 0.35. Unrelated text scores ~0.1–0.2; strong matches ~0.7–0.9. Only applies when 'Auto-include relevant memories' is on.">
        <span>Memory match threshold</span>
        <input id="am-auto-context-min-confidence" type="range"
               min="0" max="1" step="0.05"
               ?disabled=${!this._autoContext}
               .value=${String(this._autoContextMinConfidence)}
               @input=${async (/** @type {any} */ e) => {
                 const v = Number(e.target.value);
                 this._autoContextMinConfidence = v;
                 await setSetting('autoContextMinConfidence', v);
               }} />
        <span class="slider-value">${this._autoContextMinConfidence.toFixed(2)}</span>
      </label>
      <label class="row" title="Prepend the editor's active tab (path + content) to chat-worker prompts so the model sees the file you're looking at.">
        <input id="am-auto-file-context" type="checkbox"
               .checked=${this._autoFileContext}
               @change=${async (/** @type {any} */ e) => {
                 this._autoFileContext = !!e.target.checked;
                 await setSetting('autoFileContext', this._autoFileContext);
               }} />
        <span>Auto-include active editor file</span>
      </label>
    `;
  }

  _renderChatSideRow() {
    const setSide = async (/** @type {'left'|'right'} */ side) => {
      this._chatSide = side;
      await setSetting('chatSide', side);
      // Apply to #app-row immediately so the user sees the flip.
      const row = document.getElementById('app-row');
      if (row) row.classList.toggle('app-row--chat-right', side === 'right');
      this.requestUpdate();
    };
    return html`
      <div class="row">
        <span>Chat position</span>
        <span class="segmented" role="group" aria-label="Chat position">
          <button id="am-chat-side-left" class=${`cmd-btn cmd-btn--small${this._chatSide === 'left' ? ' cmd-btn--active' : ''}`} type="button"
                  @click=${() => setSide('left')}>Left</button>
          <button id="am-chat-side-right" class=${`cmd-btn cmd-btn--small${this._chatSide === 'right' ? ' cmd-btn--active' : ''}`} type="button"
                  @click=${() => setSide('right')}>Right</button>
        </span>
      </div>
    `;
  }

  _renderToolDetailsRow() {
    const s = store.get();
    const cur = s.settings.toolDetails;
    const setMode = async (/** @type {'expanded'|'collapsed'|'hidden'} */ mode) => {
      await setSetting('toolDetails', mode);
      const ns = store.get();
      store.update({ settings: { ...ns.settings, toolDetails: mode } });
    };
    return html`
      <div class="row">
        <span>Tool details</span>
        <span class="segmented" role="group" aria-label="Tool details">
          <button id="am-tool-details-expanded"
                  class=${`cmd-btn cmd-btn--small${cur === 'expanded' ? ' cmd-btn--active' : ''}`}
                  type="button" title="Show input + result inline by default"
                  @click=${() => setMode('expanded')}>Expanded</button>
          <button id="am-tool-details-collapsed"
                  class=${`cmd-btn cmd-btn--small${cur === 'collapsed' ? ' cmd-btn--active' : ''}`}
                  type="button" title="One-line summary; click to expand"
                  @click=${() => setMode('collapsed')}>Collapsed</button>
          <button id="am-tool-details-hidden"
                  class=${`cmd-btn cmd-btn--small${cur === 'hidden' ? ' cmd-btn--active' : ''}`}
                  type="button" title="Tiny badge only; no body"
                  @click=${() => setMode('hidden')}>Hidden</button>
        </span>
      </div>
    `;
  }

  /**
   * @param {'shell'|'local'|'ollama-cloud'|'openrouter'} kind
   * @param {{ model?: string }} [opts]
   */
  _emitSpawn(kind, opts = {}) {
    this.dispatchEvent(new CustomEvent('spawn', {
      detail: { kind, ...(opts.model ? { model: opts.model } : {}) },
      bubbles: true, composed: true,
    }));
  }

  _renderWorkersHeader() {
    return html`
      <div class="row row--header">
        <span>Workers</span>
        <span class="spawn-buttons">
          <button id="am-spawn-shell" class="cmd-btn cmd-btn--small" type="button"
                  title="Spawn another shell"
                  @click=${() => this._emitSpawn('shell')}>+ Shell</button>
          <button id="am-spawn-local" class="cmd-btn cmd-btn--small" type="button"
                  title="Spawn a local in-process model worker (no API key; tools via text commands)"
                  @click=${() => this._emitSpawn('local')}>+ Local</button>
          <button id="am-spawn-ollama-cloud" class="cmd-btn cmd-btn--small" type="button"
                  title="Spawn a hosted Ollama Cloud worker (uses OLLAMA_API_KEY from .env)"
                  @click=${() => this._emitSpawn('ollama-cloud',
                    this._ollamaModel ? { model: this._ollamaModel } : {})}>+ Ollama</button>
          ${this._ollamaModels.length > 0 ? html`
            <select id="am-spawn-ollama-model" class="am-select am-select--inline"
                    title="Choose the model for the next Ollama Cloud worker"
                    .value=${this._ollamaModel}
                    @change=${this._onOllamaModelChange}>
              ${this._ollamaModels.map((m) => html`
                <option value=${m} ?selected=${m === this._ollamaModel}>${m}</option>
              `)}
            </select>
          ` : ''}
        </span>
      </div>
    `;
  }

  _renderCwdRow() {
    const cwd = store.get().pendingCwd;
    return html`
      <div class="row row--cwd">
        <span class="label--small">Working dir</span>
        <button id="am-spawn-cwd" class="cwd-button" type="button"
                title=${cwd || '(repo root)'}
                @click=${pickCwd}>
          <span id="am-spawn-cwd-text">${shortenPath(cwd)}</span>
        </button>
      </div>
    `;
  }

  _renderWorkerRows() {
    const s = store.get();
    if (s.workers.length === 0) {
      return html`<div id="am-workers-detail"><div class="empty-workers">No workers. Spawn one from the empty state.</div></div>`;
    }
    return html`
      <div id="am-workers-detail">
        ${s.workers.map((w) => {
          const mirrorOn = (typeof w.memoryMirror === 'boolean')
            ? w.memoryMirror
            : s.settings.defaultMirror;
          const onRename = async (/** @type {any} */ e) => {
            const newName = (e.target.value || '').trim();
            if (!newName || newName === w.name) { e.target.value = w.name; return; }
            const r = await renameWorker(w.id, newName);
            if (!r.ok) {
              e.target.value = w.name;
              this.dispatchEvent(new CustomEvent('system-message', {
                detail: { text: `rename failed: ${r.error}` },
                bubbles: true, composed: true,
              }));
            }
            await refreshWorkers();
          };
          return html`
            <div class="worker-row am-worker-row">
              <div class="worker-row__name am-worker-row__name">
                <input type="text" .value=${w.name} title=${`${w.kind} · rename`}
                       @change=${onRename} />
              </div>
              <span class="worker-row__meta" title=${w.cwd ? `${w.kind} · ${w.cwd}` : w.kind}>${w.kind}</span>
              ${w.cwd ? html`<span class="worker-row__cwd" title=${w.cwd}>${shortenPath(w.cwd)}</span>` : ''}
              <label class="worker-row__mirror">
                <input type="checkbox" .checked=${mirrorOn}
                       @change=${(/** @type {any} */ e) => setWorkerMirror(w.id, e.target.checked)} />
                <span>save</span>
              </label>
              <button class="cmd-btn cmd-btn--small" type="button"
                      @click=${() => closeWorker(w.id)}>Close</button>
            </div>
            ${this._renderScopeChips(w)}
          `;
        })}
      </div>
    `;
  }

  /** Per-worker scope chip strip. Lives directly under each worker row.
   *  Each scope root is a chip; the cwd row gets a 🔒 badge and no
   *  remove button (it's the spawn-time fence). + Add directory opens
   *  a native picker via worker:add-scope (path arg omitted). */
  _renderScopeChips(/** @type {any} */ w) {
    // scopeRoots arrives via WorkerManager.list() — see workerManager.js.
    /** @type {string[]} */
    const roots = Array.isArray(w.scopeRoots) ? w.scopeRoots : [];
    const cwdNorm = (w.cwd || '').replace(/[\\/]+$/, '').toLowerCase();
    const isFenced = (root) => root.replace(/[\\/]+$/, '').toLowerCase() === cwdNorm;
    const onAdd = async () => {
      const t = /** @type {any} */ (window).transport;
      try { await t?.workers?.addScope?.(w.id); } catch { /* ignore */ }
      // Refresh the worker list so scopeRoots updates.
      try { await refreshWorkers(); } catch { /* ignore */ }
    };
    const onRemove = async (root) => {
      const t = /** @type {any} */ (window).transport;
      try { await t?.workers?.removeScope?.(w.id, root); } catch { /* ignore */ }
      try { await refreshWorkers(); } catch { /* ignore */ }
    };
    return html`
      <div class="worker-row__scopes">
        <span class="label--small">Scope</span>
        ${roots.length === 0
          ? html`<span class="scope-chip scope-chip--empty">(none)</span>`
          : roots.map((root) => html`
              <span class="scope-chip ${isFenced(root) ? 'scope-chip--fenced' : ''}"
                    title=${root}>
                ${isFenced(root) ? html`<span class="scope-chip__icon">🔒</span>` : ''}
                <span class="scope-chip__path">${shortenPath(root)}</span>
                ${isFenced(root) ? '' : html`
                  <button class="scope-chip__remove" type="button"
                          title="Remove from scope"
                          @click=${() => onRemove(root)}>×</button>
                `}
              </span>
            `)
        }
        <button class="cmd-btn cmd-btn--small" type="button"
                title="Add a directory to this worker's scope"
                @click=${onAdd}>+ Add</button>
      </div>
    `;
  }

  render() {
    return html`
      ${this._renderMirrorRow()}
      ${this._renderChatSideRow()}
      ${this._renderToolDetailsRow()}
      ${this._renderWorkersHeader()}
      ${this._renderCwdRow()}
      ${this._renderWorkerRows()}
    `;
  }
}

customElements.define('settings-drawer', SettingsDrawer);
