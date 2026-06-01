// @ts-check
// <worker-chips> — the always-visible strip of worker chips at the
// top of the chat surface. Each chip shows @name + a thinking dot
// while the worker is mid-turn + a token-usage badge (↑in ↓out) that
// live-updates as the worker spends tokens. Click @name to set the
// chip as the current target; click the token badge to dispatch
// `open-tokens-panel` (a hook for a future analytics view — no-op for
// now if nothing listens).
//
// Reads workers + currentTarget + thinkingWorkers from the store.
// Subscribes to transport.tokens.onUpdate for live per-worker totals.

import { LitElement, html, css } from 'lit';
import { store } from '../state/store.js';
import { selectWorker } from '../state/actions.js';

/** @returns {any} */
function transport() { return /** @type {any} */ (window).transport; }

/** Compact "12k", "1.3m" style — small numbers render verbatim. */
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
}

export class WorkerChips extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 12px 0;
    }
    /* When the workers slice is empty the host has no chips inside its
       shadow root, so it just collapses to its padding. The empty-state
       component (rendered next door) covers the visual frame. */

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--surface-3);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2px 10px;
      font-size: 11px;
      color: var(--text);
      transition: background 80ms ease, border-color 80ms ease;
    }
    .chip.is-active {
      background: var(--accent-bg);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
    .label {
      cursor: pointer;
      font-family: 'Cascadia Code', Consolas, Menlo, monospace;
    }
    .tokens {
      display: inline-flex;
      gap: 4px;
      padding: 1px 6px;
      margin-left: 2px;
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text-dim);
      font-size: 10px;
      font-family: 'Cascadia Code', Consolas, Menlo, monospace;
      cursor: pointer;
      user-select: none;
    }
    .tokens:hover { color: var(--text); }
    .tokens .arrow { color: var(--text-faint); }
    .chip.is-thinking::after {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 1s ease-in-out infinite;
      margin-left: 4px;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }
  `;

  constructor() {
    super();
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
    /** @type {(() => void) | null} */
    this._unsubscribeTokens = null;
    /** @type {Map<string, { inputTokens: number, outputTokens: number, model: string, turns: number }>} */
    this._tokensByAgent = new Map();
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => this.requestUpdate());
    // Hydrate from main, then live-subscribe. Doing both means the chip
    // shows the right number on first paint AND keeps up with new turns.
    void this._hydrateTokens();
    const t = transport();
    if (t?.tokens?.onUpdate) {
      this._unsubscribeTokens = t.tokens.onUpdate((msg) => {
        this._applyTokens(msg?.snapshot);
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribeTokens?.();
  }

  async _hydrateTokens() {
    try {
      const t = transport();
      if (!t?.tokens?.snapshot) return;
      const r = await t.tokens.snapshot();
      if (r && r.ok) this._applyTokens(r.snapshot);
    } catch { /* ignore */ }
  }

  _applyTokens(snap) {
    if (!snap || !Array.isArray(snap.byAgent)) return;
    const next = new Map();
    for (const a of snap.byAgent) {
      next.set(a.agentId, {
        inputTokens: a.inputTokens | 0,
        outputTokens: a.outputTokens | 0,
        model: a.model || '',
        turns: a.turns | 0,
      });
    }
    this._tokensByAgent = next;
    this.requestUpdate();
  }

  /** @param {string} id */
  _onClick(id) {
    selectWorker(id);
    this.dispatchEvent(new CustomEvent('select', {
      detail: { id }, bubbles: true, composed: true,
    }));
  }

  _onTokensClick(id, ev) {
    ev.stopPropagation();
    this.dispatchEvent(new CustomEvent('open-tokens-panel', {
      detail: { id }, bubbles: true, composed: true,
    }));
  }

  render() {
    const s = store.get();
    return s.workers.map((w) => {
      const tok = this._tokensByAgent.get(w.id);
      const showTokens = !!tok && (tok.inputTokens > 0 || tok.outputTokens > 0);
      const tokenTitle = tok
        ? `${tok.model || 'no model'}\n${tok.turns} turn${tok.turns === 1 ? '' : 's'} · ` +
          `in: ${tok.inputTokens.toLocaleString()} · out: ${tok.outputTokens.toLocaleString()}`
        : 'no tokens recorded yet';
      return html`
        <div class=${`chip worker-chip${w.id === s.currentTarget ? ' is-active worker-chip--active' : ''}${s.thinkingWorkers.has(w.id) ? ' is-thinking worker-chip--thinking' : ''}`}
             title=${`${w.kind}\ncwd: ${w.cwd || '(default)'}\nid: ${w.id}`}>
          <span class="label worker-chip__label" @click=${() => this._onClick(w.id)}>@${w.name}</span>
          ${showTokens ? html`
            <span class="tokens worker-chip__tokens"
                  title=${tokenTitle}
                  @click=${(/** @type {any} */ ev) => this._onTokensClick(w.id, ev)}>
              <span class="arrow">↑</span>${fmtTokens(tok.inputTokens)}
              <span class="arrow">↓</span>${fmtTokens(tok.outputTokens)}
            </span>` : ''}
        </div>
      `;
    });
  }
}

customElements.define('worker-chips', WorkerChips);
