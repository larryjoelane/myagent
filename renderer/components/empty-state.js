// @ts-check
// <empty-state> — the "Drive Agentic workers" panel shown when no
// workers exist. Spawn buttons + cwd picker. Renders nothing when
// any worker is attached (or any chat bubble has appeared, which
// includes things like @memory results).
//
// Subscribes to the store so visibility re-evaluates as workers come
// and go. Spawn click dispatches a `spawn` CustomEvent so the parent
// (app-root) can route through actions.spawnWorker — keeps the
// component free of IPC concerns.

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
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  /** @param {'claude'|'shell'|'semantic'} kind */
  _emitSpawn(kind) {
    this.dispatchEvent(new CustomEvent('spawn', {
      detail: { kind }, bubbles: true, composed: true,
    }));
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
