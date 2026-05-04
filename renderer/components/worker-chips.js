// @ts-check
// <worker-chips> — the always-visible strip of worker chips at the
// top of the chat surface. Each chip shows @name + a thinking dot
// while the worker is mid-turn. Click to set the chip as the current
// target for the next prompt.
//
// Reads workers + currentTarget + thinkingWorkers from the store.
// Emits a 'select' CustomEvent (detail.id) when clicked; the parent
// routes to actions.selectWorker.

import { LitElement, html, css } from 'lit';
import { store } from '../state/store.js';
import { selectWorker } from '../state/actions.js';

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
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  /** @param {string} id */
  _onClick(id) {
    selectWorker(id);
    this.dispatchEvent(new CustomEvent('select', {
      detail: { id }, bubbles: true, composed: true,
    }));
  }

  render() {
    const s = store.get();
    return s.workers.map((w) => html`
      <div class=${`chip worker-chip${w.id === s.currentTarget ? ' is-active worker-chip--active' : ''}${s.thinkingWorkers.has(w.id) ? ' is-thinking worker-chip--thinking' : ''}`}
           title=${`${w.kind}\ncwd: ${w.cwd || '(default)'}\nid: ${w.id}`}>
        <span class="label worker-chip__label" @click=${() => this._onClick(w.id)}>@${w.name}</span>
      </div>
    `);
  }
}

customElements.define('worker-chips', WorkerChips);
