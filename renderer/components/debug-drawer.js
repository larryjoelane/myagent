// @ts-check
// <debug-drawer> — live event panel for the agentic loop.
//
// Subscribes to transport.chat.on(...) and keeps a rolling ring buffer
// of recent events. Each event renders as a one-line row: timestamp +
// type chip + compact summary. Click a row to expand into a JSON view
// of the full payload. Per-worker filter (defaults to currentTarget;
// "all" includes every worker). Auto-scrolls to latest unless the user
// scrolled up, then a "scroll to latest" affordance appears.
//
// The drawer is read-only — no actions, just observation. It complements
// the session log on disk (.myagent/sessions/session-*.ndjson) which
// captures the same events for post-mortems.
//
// Visibility controlled by an [open] boolean property, mirroring
// settings-drawer. Parent (<agent-manager>) toggles it on/off.

import { LitElement, html, css } from 'lit';
import { store } from '../state/store.js';
import { summarize, chipClass, eventTag } from './debugEventSummary.js';

const SUBSCRIBED_EVENTS = [
  'chat:user',
  'chat:turn-start',
  'chat:tool-call',
  'chat:tool-result',
  'chat:turn-end',
  'chat:error',
  'chat:context-used',
  'chat:driver-exit',
  'chat:env-context',
];

const RING_SIZE = 200;
const VERBOSE_EXTRA = ['chat:chunk'];

/** @returns {any} */
function transport() { return /** @type {any} */ (window).transport; }

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export class DebugDrawer extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    _events: { state: true },
    _filterAgentId: { state: true },
    _expanded: { state: true },
    _verbose: { state: true },
    _autoScroll: { state: true },
  };

  static styles = css`
    :host {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      background: var(--surface-2, #1d1d1d);
      border-bottom: 1px solid var(--border, #333);
      max-height: 320px;
      overflow: hidden;
      transition: max-height 160ms ease, opacity 160ms ease;
      font-family: 'Cascadia Code', Consolas, Menlo, monospace;
      font-size: 11px;
      color: var(--text, #ddd);
    }
    :host(:not([open])) {
      max-height: 0;
      opacity: 0;
      border-bottom-width: 0;
    }
    .toolbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border, #333);
      background: var(--surface-3, #232323);
    }
    .toolbar select,
    .toolbar button {
      background: var(--surface-2, #1d1d1d);
      color: var(--text, #ddd);
      border: 1px solid var(--border, #3c3c3c);
      border-radius: 3px;
      padding: 2px 6px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .toolbar button:hover { border-color: var(--accent, #569cd6); }
    .toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
    }
    .toolbar .spacer { flex: 1 1 auto; }
    .toolbar .count { color: var(--text-dim, #888); }

    .events {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px 0;
    }
    .row {
      display: grid;
      grid-template-columns: 80px 86px 1fr;
      gap: 6px;
      align-items: baseline;
      padding: 2px 10px;
      cursor: pointer;
      border-bottom: 1px solid transparent;
    }
    .row:hover { background: rgba(255, 255, 255, 0.03); }
    .row.is-expanded {
      background: rgba(255, 255, 255, 0.05);
      border-bottom: 1px solid var(--border, #333);
    }
    .row__time {
      color: var(--text-faint, #666);
      font-size: 10px;
    }
    .chip {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      text-transform: lowercase;
      text-align: center;
      background: #2a2a2a;
      color: #bbb;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .debug-chip--user        { background: #1f3a4d; color: #9cd; }
    .debug-chip--tool-call   { background: #3a2e1f; color: #e8b878; }
    .debug-chip--tool-result { background: #2a3a1f; color: #b8e878; }
    .debug-chip--turn-start  { background: #2a2a2a; color: #888; }
    .debug-chip--turn-end    { background: #2a3a2a; color: #88c888; }
    .debug-chip--error       { background: #4a1f1f; color: #e88; }
    .debug-chip--chunk       { background: #2a2a2a; color: #666; }
    .debug-chip--context     { background: #3a2f4a; color: #c0a0e0; }
    .debug-chip--exit        { background: #3a1f1f; color: #d88; }
    .debug-chip--env         { background: #1f2a3a; color: #88c8e8; }
    .debug-chip--other       { background: #2a2a2a; color: #888; }

    .row__body {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row__detail {
      grid-column: 1 / -1;
      padding: 6px 10px 8px 172px;
      color: var(--text-dim, #aaa);
      white-space: pre-wrap;
      word-break: break-all;
      font-size: 10px;
      max-height: 240px;
      overflow-y: auto;
    }
    .row__agent {
      color: var(--text-faint, #666);
      margin-right: 4px;
    }
    .empty {
      padding: 18px 12px;
      color: var(--text-faint, #666);
      text-align: center;
    }
    .scroll-to-latest {
      position: sticky;
      bottom: 4px;
      align-self: center;
      margin: 0 auto;
      background: var(--accent, #569cd6);
      color: #000;
      border: none;
      border-radius: 12px;
      padding: 2px 10px;
      font-family: inherit;
      font-size: 10px;
      cursor: pointer;
    }
  `;

  constructor() {
    super();
    this.open = false;
    /** @type {Array<any>} */
    this._events = [];
    this._filterAgentId = ''; // '' === all
    /** @type {Set<number>} indices into _events that are currently expanded */
    this._expanded = new Set();
    this._verbose = false;
    this._autoScroll = true;
    /** @type {Array<() => void>} */
    this._unsubs = [];
    /** @type {(() => void) | null} */
    this._storeUnsub = null;
    /** @type {number} monotonic counter so expansion survives ring-buffer drops */
    this._seq = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this._subscribeAll();
    // Mirror the chat's current target as the default filter so the
    // drawer shows what the user is most likely looking at.
    this._storeUnsub = store.subscribe(() => {
      // Only auto-update the filter when it's at the default empty
      // state OR matches the previous currentTarget — don't trample
      // an explicit user choice.
      const s = store.get();
      if (!this._filterAgentId && s.currentTarget) {
        this._filterAgentId = s.currentTarget;
      }
    });
    const s = store.get();
    if (s.currentTarget) this._filterAgentId = s.currentTarget;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const u of this._unsubs) { try { u(); } catch { /* ignore */ } }
    this._unsubs = [];
    this._storeUnsub?.();
    this._storeUnsub = null;
  }

  _subscribeAll() {
    const t = transport();
    if (!t || !t.chat || typeof t.chat.on !== 'function') return;
    const all = this._verbose ? [...SUBSCRIBED_EVENTS, ...VERBOSE_EXTRA] : SUBSCRIBED_EVENTS;
    for (const name of all) {
      const unsub = t.chat.on(name, (payload) => this._onEvent(name, payload));
      this._unsubs.push(unsub);
    }
  }

  _resubscribe() {
    for (const u of this._unsubs) { try { u(); } catch { /* ignore */ } }
    this._unsubs = [];
    this._subscribeAll();
  }

  _onEvent(name, payload) {
    const entry = {
      seq: this._seq++,
      ts: Date.now(),
      name,
      payload: payload || {},
      agentId: payload?.agentId || '',
    };
    const next = this._events.length >= RING_SIZE
      ? this._events.slice(this._events.length - RING_SIZE + 1)
      : this._events.slice();
    next.push(entry);
    this._events = next;
    if (this._autoScroll) {
      // Defer one frame so the new row is laid out before we scroll.
      requestAnimationFrame(() => this._scrollToBottom());
    }
  }

  _scrollToBottom() {
    const list = /** @type {HTMLElement|null} */ (this.renderRoot.querySelector('.events'));
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  _onScroll(ev) {
    const el = /** @type {HTMLElement} */ (ev.currentTarget);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    if (this._autoScroll !== atBottom) this._autoScroll = atBottom;
  }

  _toggleExpand(seq) {
    const next = new Set(this._expanded);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    this._expanded = next;
  }

  _clear() {
    this._events = [];
    this._expanded = new Set();
  }

  _onFilterChange(ev) {
    const target = /** @type {HTMLSelectElement} */ (ev.target);
    this._filterAgentId = target.value;
  }

  _onVerboseChange(ev) {
    const target = /** @type {HTMLInputElement} */ (ev.target);
    this._verbose = target.checked;
    this._resubscribe();
  }

  _filteredEvents() {
    if (!this._filterAgentId) return this._events;
    return this._events.filter((e) => e.agentId === this._filterAgentId);
  }

  _workersForFilter() {
    const s = store.get();
    return s.workers || [];
  }

  render() {
    const filtered = this._filteredEvents();
    const workers = this._workersForFilter();
    return html`
      <div class="toolbar">
        <label>worker:
          <select @change=${this._onFilterChange} .value=${this._filterAgentId}>
            <option value="">all</option>
            ${workers.map((w) => html`
              <option value=${w.id} ?selected=${w.id === this._filterAgentId}>@${w.name}</option>
            `)}
          </select>
        </label>
        <label>
          <input type="checkbox" .checked=${this._verbose} @change=${this._onVerboseChange} />
          verbose (chunks)
        </label>
        <span class="spacer"></span>
        <span class="count">${filtered.length} / ${this._events.length}</span>
        <button @click=${this._clear} title="Clear the visible event buffer">clear</button>
      </div>
      <div class="events" @scroll=${this._onScroll}>
        ${filtered.length === 0
          ? html`<div class="empty">No events yet. Send a prompt to a worker.</div>`
          : filtered.map((e) => this._renderRow(e))}
        ${!this._autoScroll && filtered.length > 0
          ? html`<button class="scroll-to-latest" @click=${() => { this._autoScroll = true; this._scrollToBottom(); }}>↓ latest</button>`
          : null}
      </div>
    `;
  }

  _renderRow(e) {
    const isExpanded = this._expanded.has(e.seq);
    const summary = summarize(e.name, e.payload);
    const cls = chipClass(e.name);
    const tag = eventTag(e.name);
    const agentShort = e.agentId ? e.agentId.slice(0, 6) : '';
    return html`
      <div class=${`row ${isExpanded ? 'is-expanded' : ''}`}
           @click=${() => this._toggleExpand(e.seq)}>
        <span class="row__time">${fmtTime(e.ts)}</span>
        <span class=${`chip ${cls}`}>${tag}</span>
        <span class="row__body">
          ${agentShort ? html`<span class="row__agent">${agentShort}</span>` : null}
          ${summary}
        </span>
        ${isExpanded
          ? html`<div class="row__detail">${prettyJson(e.payload)}</div>`
          : null}
      </div>
    `;
  }
}

function prettyJson(payload) {
  try { return JSON.stringify(payload, null, 2); }
  catch { return '(unserializable)'; }
}

customElements.define('debug-drawer', DebugDrawer);
