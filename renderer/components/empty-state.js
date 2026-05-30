// @ts-check
// <empty-state> — the "Drive Agentic workers" panel shown when no
// workers exist. Spawn buttons + cwd picker.
//
// Visibility rule: visible iff workers.length === 0. The chat surface
// stays visible alongside it so a "no worker — pick one" system bubble
// from a premature submit doesn't trap the user in a dead-end where the
// spawn buttons have vanished but no worker is attached.
//
// Owns its own visibility:
//   - Subscribes to the store so the worker count drives re-evaluation.
//
// Spawn click dispatches a `spawn` CustomEvent so the parent routes
// through actions.spawnWorker — keeps the component free of IPC.

import { LitElement, html, css } from 'lit';
import { store } from '../state/store.js';
import { pickCwd } from '../state/actions.js';
import { cmdBtnStyles } from './styles.js';

/** @returns {string} */
function shortenCwd(p) {
  if (!p) return '(repo root)';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

export class EmptyState extends LitElement {
  static properties = {
    /** Caller controls visibility — driven by the chat surface. */
    hidden: { type: Boolean, reflect: true },
    /** Available Ollama Cloud models (from main via .env). */
    _ollamaModels: { state: true },
    /** Currently-selected Ollama Cloud model in the dropdown. */
    _ollamaModel: { state: true },
  };

  static styles = [
    cmdBtnStyles,
    css`
      :host {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 28px 22px;
        text-align: center;
        align-items: center;
        justify-content: flex-start;
        overflow-y: auto;
      }
      :host([hidden]) { display: none; }

      .title {
        margin: 0;
        font-size: 16px;
        color: var(--text);
      }
      .body {
        margin: 0;
        color: var(--text-dim);
        font-size: 12px;
        line-height: 1.5;
        max-width: 320px;
      }
      .actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        max-width: 280px;
        align-items: stretch;
      }
      .actions .cmd-btn { padding: 8px 12px; }

      /* Row that pairs the Ollama Cloud spawn button with its model
         dropdown. Stacks vertically inside the same .actions column. */
      .ollama-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ollama-row .cmd-btn { width: 100%; }
      .ollama-model {
        width: 100%;
        background: #2a2a2a;
        color: var(--text);
        border: 1px solid #3a3a3a;
        border-radius: 3px;
        padding: 4px 6px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .ollama-model:focus {
        outline: none;
        border-color: var(--accent);
      }

      .cwd {
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: center;
        margin-top: 6px;
        font-size: 11px;
        color: var(--text-faint);
        max-width: 320px;
        width: 100%;
      }
      .cwd__label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .cwd__button {
        background: transparent;
        border: 1px dashed var(--border);
        border-radius: 4px;
        color: var(--text-dim);
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        font-size: 11px;
        padding: 4px 8px;
        cursor: pointer;
        width: 100%;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: border-color 80ms ease, color 80ms ease;
      }
      .cwd__button:hover {
        border-color: var(--accent);
        color: var(--text);
      }
    `,
  ];

  constructor() {
    super();
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
    /** @type {string[]} */
    this._ollamaModels = [];
    this._ollamaModel = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => {
      this.requestUpdate();
      this._refreshVisibility();
    });
    this._refreshVisibility();
    // Fetch the Ollama Cloud model list lazily — fire-and-forget.
    // Failure leaves _ollamaModels empty; the dropdown is hidden in
    // that case and the user gets the env default.
    this._loadOllamaModels();
  }

  async _loadOllamaModels() {
    try {
      const t = /** @type {any} */ (window).transport;
      if (!t?.workers?.ollamaCloudModels) return;
      const r = await t.workers.ollamaCloudModels();
      if (!r?.ok || !Array.isArray(r.models) || r.models.length === 0) return;
      this._ollamaModels = r.models;
      this._ollamaModel = r.default || r.models[0];
    } catch { /* ignore — leave dropdown hidden */ }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  // Visibility = no workers. The chat surface stays visible alongside
  // empty-state when both apply, so a "pick a worker first" error
  // bubble doesn't hide the spawn buttons (the dead-end this used to
  // create when the rule was `!hasWorkers && chatEmpty`). We still
  // clear the legacy chat--hidden class in case prior code set it.
  _refreshVisibility() {
    const hasWorkers = store.get().workers.length > 0;
    const showEmpty = !hasWorkers;
    this.hidden = !showEmpty;
    this.classList.toggle('agent-manager__empty--hidden', !showEmpty);
    const chat = document.getElementById('am-chat');
    if (chat) chat.classList.remove('agent-manager__chat--hidden');
  }

  /**
   * @param {'claude'|'shell'|'semantic'|'ollama-cloud'} kind
   * @param {{ model?: string }} [opts]
   */
  _emitSpawn(kind, opts = {}) {
    this.dispatchEvent(new CustomEvent('spawn', {
      detail: { kind, ...(opts.model ? { model: opts.model } : {}) },
      bubbles: true, composed: true,
    }));
  }

  _onOllamaModelChange(/** @type {Event} */ ev) {
    const target = /** @type {HTMLSelectElement} */ (ev.target);
    this._ollamaModel = target.value;
  }

  render() {
    const cwd = store.get().pendingCwd;
    const cwdLabel = shortenCwd(cwd);
    const cwdTooltip = cwd || '(repo root)';
    // IDs preserved (am-empty-spawn-claude, etc.) so existing Playwright
    // tests can locate them via shadow-piercing selectors:
    //   win.locator('empty-state').locator('#am-empty-spawn-claude')
    return html`
      <h2 class="title">Drive Agentic workers from here</h2>
      <p class="body">
        Spawn a worker and send prompts from this pane. Responses stream back here automatically.
      </p>
      <div class="actions">
        <button id="am-empty-spawn-claude" class="cmd-btn cmd-btn--primary" type="button"
                @click=${() => this._emitSpawn('claude')}>
          + Spawn Claude worker
        </button>
        <button id="am-empty-spawn-shell" class="cmd-btn" type="button"
                @click=${() => this._emitSpawn('shell')}>
          + Open shell
        </button>
        <button id="am-empty-spawn-semantic" class="cmd-btn" type="button"
                title="Spawn a semantic-routing agent (in-process, no LLM)"
                @click=${() => this._emitSpawn('semantic')}>
          + Spawn Semantic worker
        </button>
        <div class="ollama-row">
          <button id="am-empty-spawn-ollama-cloud" class="cmd-btn" type="button"
                  title="Spawn a hosted Ollama Cloud worker (uses OLLAMA_API_KEY from .env)"
                  @click=${() => this._emitSpawn('ollama-cloud',
                    this._ollamaModel ? { model: this._ollamaModel } : {})}>
            + Spawn Ollama Cloud worker
          </button>
          ${this._ollamaModels.length > 0 ? html`
            <select id="am-empty-ollama-model" class="ollama-model"
                    title="Choose the model for this Ollama Cloud worker"
                    .value=${this._ollamaModel}
                    @change=${this._onOllamaModelChange}>
              ${this._ollamaModels.map((m) => html`
                <option value=${m} ?selected=${m === this._ollamaModel}>${m}</option>
              `)}
            </select>
          ` : ''}
        </div>
      </div>
      <div class="cwd">
        <span class="cwd__label">Working directory:</span>
        <button id="am-empty-cwd" class="cwd__button" type="button"
                title=${cwdTooltip}
                @click=${pickCwd}>
          <span id="am-empty-cwd-text">${cwdLabel}</span>
        </button>
      </div>
    `;
  }
}

customElements.define('empty-state', EmptyState);
