// @ts-check
// <settings-drawer> — the gear-icon panel. All knobs the chat surface
// exposes live here:
//   - Mirror toggles (default + auto-context)
//   - Chat side picker (Left | Right) — persisted via transport.settings
//   - Tool details mode (Expanded | Collapsed | Hidden) — persisted
//   - Workers section: spawn buttons + cwd picker + per-worker rows
//   - Semantic device picker + status line + Benchmark/DevTools buttons
//   - Explain model picker + cache info card + Pre-download/Recheck
//   - Default-explain toggle
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
  loadEmbedderStatus, loadGenerationModels, refreshGenerationModelStatuses,
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
      .spawn-buttons { display: inline-flex; gap: 4px; }
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
    this.requestUpdate();
    loadEmbedderStatus();
    loadGenerationModels();
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

  _emitSpawn(/** @type {'claude'|'shell'|'semantic'} */ kind) {
    this.dispatchEvent(new CustomEvent('spawn', {
      detail: { kind }, bubbles: true, composed: true,
    }));
  }

  _renderWorkersHeader() {
    return html`
      <div class="row row--header">
        <span>Workers</span>
        <span class="spawn-buttons">
          <button id="am-spawn-claude" class="cmd-btn cmd-btn--small cmd-btn--primary" type="button"
                  title="Spawn another Claude worker"
                  @click=${() => this._emitSpawn('claude')}>+ Claude</button>
          <button id="am-spawn-shell" class="cmd-btn cmd-btn--small" type="button"
                  title="Spawn another shell"
                  @click=${() => this._emitSpawn('shell')}>+ Shell</button>
          <button id="am-spawn-semantic" class="cmd-btn cmd-btn--small" type="button"
                  title="Spawn a semantic-routing agent (in-process, no LLM)"
                  @click=${() => this._emitSpawn('semantic')}>+ Semantic</button>
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

  _renderDeviceRow() {
    const s = store.get();
    const onChange = (/** @type {any} */ e) => {
      const v = e.target.value;
      store.update({ pendingDevice: v });
    };
    return html`
      <div class="row row--device">
        <span class="label--small">Semantic device</span>
        <select id="am-spawn-device" class="am-select" .value=${s.pendingDevice}
                title="Compute device for the next Semantic worker spawn"
                @change=${onChange}>
          <option value="cpu">CPU</option>
          <option value="auto">Auto (prefer WebGPU)</option>
          <option value="webgpu">WebGPU</option>
        </select>
      </div>
      ${this._renderDeviceStatus()}
      ${this._renderDeviceTools()}
    `;
  }

  _renderDeviceStatus() {
    const s = store.get();
    const es = s.embedderStatus;
    const dev = s.pendingDevice || 'cpu';
    let text = 'Embedder status unknown.';
    let warn = false;
    if (es) {
      const model = es.modelId || 'embedder';
      if (dev === 'cpu') {
        text = `${model} on CPU (always available).`;
      } else if (es.webgpuRuntimeAvailable) {
        text = `${model} will use ${dev === 'auto' ? 'WebGPU when possible' : 'WebGPU'}.`;
      } else {
        text = `${model}: WebGPU not available in current build — will fall back to CPU.`;
        warn = true;
      }
    }
    return html`
      <div class="row row--device-status">
        <span id="am-device-status" class=${warn ? 'device-status--warn' : ''}>${text}</span>
      </div>
    `;
  }

  _renderDeviceTools() {
    const benchmark = async () => {
      const dev = store.get().pendingDevice || 'cpu';
      const btn = /** @type {HTMLButtonElement|null} */ (this.renderRoot.querySelector('#am-device-benchmark'));
      const orig = btn?.textContent;
      if (btn) { btn.disabled = true; btn.textContent = `Benchmarking ${dev}…`; }
      try {
        const r = await transport().models.embedderBenchmark({ device: dev, iterations: 20 });
        if (!r.ok) throw new Error(r.error || 'benchmark failed');
        this.dispatchEvent(new CustomEvent('system-message', {
          detail: { text: `Benchmark (${dev}, ${r.iterations} embeds): median ${r.medianMs}ms · mean ${r.meanMs}ms · min ${r.minMs}ms · max ${r.maxMs}ms` },
          bubbles: true, composed: true,
        }));
      } catch (err) {
        this.dispatchEvent(new CustomEvent('system-message', {
          detail: { text: `Benchmark failed: ${/** @type {Error} */ (err).message}` },
          bubbles: true, composed: true,
        }));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig || 'Benchmark'; }
      }
    };
    const devtools = async () => {
      try { await transport().models.embedderDevTools(); }
      catch (err) {
        this.dispatchEvent(new CustomEvent('system-message', {
          detail: { text: `devtools failed: ${/** @type {Error} */ (err).message}` },
          bubbles: true, composed: true,
        }));
      }
    };
    return html`
      <div class="row row--device-tools">
        <button id="am-device-benchmark" class="cmd-btn cmd-btn--small" type="button"
                title="Run a 20-embed benchmark with the chosen device"
                @click=${benchmark}>Benchmark</button>
        <button id="am-device-devtools" class="cmd-btn cmd-btn--small cmd-btn--muted" type="button"
                title="Open DevTools on the hidden embedder host (verify WebGPU)"
                @click=${devtools}>DevTools</button>
      </div>
    `;
  }

  _renderGenModelRow() {
    const s = store.get();
    const onChange = (/** @type {any} */ e) => {
      store.update({ pendingGenerationModelId: e.target.value || '' });
    };
    return html`
      <div class="row row--gen-model">
        <span class="label--small">Explain model</span>
        <select id="am-spawn-gen-model" class="am-select" .value=${s.pendingGenerationModelId}
                title="Generative model used by --explain on Semantic workers"
                @change=${onChange}>
          <option value="">(none — explain disabled)</option>
          ${(s.generationModels || []).map((/** @type {any} */ m) => {
            const cs = m._cacheStatus;
            const dot = cs ? (cs.cached ? '●' : '○') : '○';
            return html`<option value=${m.id}>${dot} ${m.name} — ~${m.approxSizeMB}MB</option>`;
          })}
        </select>
      </div>
      ${this._renderGenModelInfo()}
      <label class="row row--explain">
        <input id="am-default-explain" type="checkbox"
               .checked=${s.pendingDefaultExplain}
               @change=${(/** @type {any} */ e) => store.update({ pendingDefaultExplain: !!e.target.checked })} />
        <span>Explain results by default (use --no-explain to skip)</span>
      </label>
    `;
  }

  _renderGenModelInfo() {
    const s = store.get();
    const id = s.pendingGenerationModelId;
    if (!id) return html`<div id="am-gen-model-info" class="gen-model-info" hidden></div>`;
    const m = (s.generationModels || []).find((/** @type {any} */ x) => x.id === id);
    if (!m) return html`<div id="am-gen-model-info" class="gen-model-info" hidden></div>`;
    const cs = m._cacheStatus;
    let cacheText = 'checking…';
    let cacheCls = '';
    let warmDisabled = true;
    let warmText = 'Pre-download';
    let warmTitle = 'Download + load the model now (otherwise happens on first --explain)';
    if (cs) {
      warmDisabled = false;
      if (cs.cached) {
        const mb = (cs.totalBytes / 1024 / 1024).toFixed(0);
        cacheText = `cached (${mb}MB on disk in browser cache)`;
        cacheCls = 'gen-cache--ok';
        warmText = 'Re-load';
        warmTitle = 'Force a reload of the model into memory';
      } else {
        const partial = cs.totalBytes > 0
          ? ` (partial: ${(cs.totalBytes / 1024 / 1024).toFixed(0)}MB present, missing ${cs.missingRequired.join(', ')})`
          : '';
        cacheText = `not cached — ~${m.approxSizeMB}MB will download on first use${partial}`;
        cacheCls = 'gen-cache--missing';
        warmText = 'Pre-download';
        warmTitle = `Download ~${m.approxSizeMB}MB and load the model now (otherwise happens on first --explain)`;
      }
    }
    const url = `https://huggingface.co/${m.repo}`;
    const onWarmup = async () => {
      const btn = /** @type {HTMLButtonElement|null} */ (this.renderRoot.querySelector('#am-gen-model-warmup'));
      const orig = btn?.textContent;
      if (btn) { btn.disabled = true; btn.textContent = `Downloading ${m.name}…`; }
      const wasCached = !!cs?.cached;
      const t0 = Date.now();
      try {
        const r = await transport().models.warmup(m.id, store.get().pendingDevice || undefined);
        if (!r.ok) throw new Error(r.error || 'warmup failed');
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const where = r.resolvedDevice?.device || 'unknown';
        this.dispatchEvent(new CustomEvent('system-message', {
          detail: { text: `Model "${m.name}" ready on ${where} in ${secs}s${wasCached ? ' (was cached)' : ' (downloaded + loaded)'}.` },
          bubbles: true, composed: true,
        }));
        try {
          const cs2 = await transport().models.cacheStatus(m.id);
          if (cs2.ok) m._cacheStatus = cs2;
          await refreshGenerationModelStatuses();
        } catch { /* ignore */ }
        store.bump();
      } catch (err) {
        this.dispatchEvent(new CustomEvent('system-message', {
          detail: { text: `Pre-download of "${m.name}" failed: ${/** @type {Error} */ (err).message}` },
          bubbles: true, composed: true,
        }));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig || warmText; }
      }
    };
    return html`
      <div id="am-gen-model-info" class="gen-model-info">
        <div class="gen-row">
          <span class="gen-label">Source</span>
          <a id="am-gen-model-src" class="gen-link" href=${url} target="_blank" rel="noopener" title=${url}>${m.repo}</a>
        </div>
        <div class="gen-row">
          <span class="gen-label">Cache</span>
          <span id="am-gen-model-cache" class=${`gen-cache ${cacheCls}`}>${cacheText}</span>
        </div>
        <div class="gen-row gen-row--actions">
          <button id="am-gen-model-warmup" class="cmd-btn cmd-btn--small" type="button"
                  ?disabled=${warmDisabled} title=${warmTitle}
                  @click=${onWarmup}>${warmText}</button>
          <button id="am-gen-model-recheck" class="cmd-btn cmd-btn--small cmd-btn--muted" type="button"
                  title="Re-check the cache for this model"
                  @click=${async () => { await refreshGenerationModelStatuses(); }}>Recheck</button>
        </div>
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
          `;
        })}
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
      ${this._renderDeviceRow()}
      ${this._renderGenModelRow()}
      ${this._renderWorkerRows()}
    `;
  }
}

customElements.define('settings-drawer', SettingsDrawer);
