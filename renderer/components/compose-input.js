// @ts-check
// <compose-input> — message composer at the bottom of the chat surface.
//
// Owns:
//   - The textarea (auto-grow on input, capped via CSS max-height)
//   - Send button
//   - @-mention popup (filtered by store.workers + the @-token under cursor)
//   - Slash-command popup (built-in commands + the current worker's
//     toolkit, if any; filtered by the typed /token)
//   - Keyboard nav within either popup (ArrowUp/Down, Tab/Enter to accept,
//     Escape to dismiss)
//   - Enter to submit (Shift+Enter for newline)
//
// The component is intentionally agnostic about *what* "send" means — it
// dispatches a `submit` event with the current text, and the parent
// (agentManager.js for now, app-root later) routes that through the
// existing send() logic.
//
// Programmatic API:
//   value         (getter/setter)  — read or replace the textarea value
//   appendValue(text)              — append text + newline if needed,
//                                    used by memory-bubble click-to-insert
//   focus()                        — focus the textarea
//
// Why expose value as a property: send() in agentManager.js needs to
// read the textarea AFTER the user clicks send (or hits Enter), and we
// want to clear it AFTER a successful send. The submit event delivers
// detail.text, but tests and other code paths still poke at value
// directly via #am-input.value (which is now a property on the host).

import { LitElement, html, css } from 'lit';
import { store } from '../state/store.js';
import { cmdBtnStyles } from './styles.js';

// Built-in slash commands — always available in any chat, independent of
// which worker (if any) is attached. These are the renderer-side commands
// handled in agentManager.send() BEFORE the worker routing (see
// renderer/commands/*.js). Drivers that expose their own `toolkit` (none
// today, but the path is kept) get their tools merged in on top.
//
// `id` is the command name after the `/`; `description` shows as the popup
// subtitle. Keep ids in sync with the command parsers.
const BUILTIN_SLASH_COMMANDS = [
  { id: 'memory-search', description: 'Search memory and show results inline. Flags: --all, --limit N, --min X. Alias of @memory.' },
  { id: 'attach', description: 'Stage a file to include with your next message.' },
];

export class ComposeInput extends LitElement {
  static styles = [
    cmdBtnStyles,
    css`
      :host {
        position: relative;
        display: flex;
        align-items: stretch;
        gap: 6px;
        padding: 8px 12px;
        background: #222;
        border-top: 1px solid #3c3c3c;
        flex: 0 0 auto;
        flex-shrink: 0;
      }
      textarea {
        flex: 1 1 auto;
        min-height: 80px;
        max-height: 220px;
        background: #1e1e1e;
        color: #ddd;
        border: 1px solid #3c3c3c;
        border-radius: 4px;
        padding: 6px 8px;
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        font-size: 12px;
        resize: none;
        line-height: 1.4;
      }
      textarea:focus {
        outline: none;
        border-color: #569cd6;
      }
      .popup {
        position: absolute;
        bottom: 100%;
        left: 12px;
        right: 60px;
        background: #2a2a2a;
        border: 1px solid #3c3c3c;
        border-radius: 4px;
        max-height: 160px;
        overflow-y: auto;
        z-index: 1;
        box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
      }
      .popup[hidden] { display: none; }
      .item {
        padding: 5px 10px;
        font-family: 'Cascadia Code', Consolas, Menlo, monospace;
        font-size: 12px;
        color: #ddd;
        cursor: pointer;
      }
      .item:hover,
      .item--active { background: #1e3a5c; color: #cce6ff; }
      .item--slash { padding: 6px 10px; }
      .item__head {
        font-weight: 600;
        color: var(--accent-fg);
      }
      .item--slash:not(.item--active) .item__head {
        color: var(--accent);
      }
      .item__sub {
        font-size: 10px;
        color: var(--text-faint);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item--active .item__sub { color: var(--accent-fg); opacity: 0.8; }
      .item--empty {
        color: var(--text-faint);
        font-style: italic;
      }
    `,
  ];

  static properties = {
    /** What's in the popup right now: 'mention' | 'slash' | null (closed). */
    _popupMode: { state: true },
    /** Current matches list shown in the popup. */
    _matches: { state: true },
    /** Highlighted index for slash popup keyboard nav. */
    _slashSelected: { state: true },
    /** When true the primary button renders as Stop and dispatches 'cancel'. */
    busy: { type: Boolean, reflect: true },
  };

  constructor() {
    super();
    /** @type {'mention'|'slash'|null} */
    this._popupMode = null;
    /** @type {Array<any>} */
    this._matches = [];
    /** @type {number} */
    this._slashSelected = 0;
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
    /** @type {boolean} */
    this.busy = false;
  }

  _cancel() {
    this.dispatchEvent(new CustomEvent('cancel', { bubbles: true, composed: true }));
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = store.subscribe(() => {
      // Worker list / toolkit changes can affect the popup contents.
      if (this._popupMode) this._refreshPopup();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  // ---- Programmatic API --------------------------------------------------

  /** @returns {HTMLTextAreaElement|null} */
  get _textarea() {
    return /** @type {HTMLTextAreaElement|null} */ (this.renderRoot.querySelector('textarea'));
  }

  /** @returns {string} */
  get value() {
    return this._textarea?.value ?? '';
  }

  /** @param {string} v */
  set value(v) {
    const ta = this._textarea;
    if (ta) {
      ta.value = v;
      this._autoGrow();
    }
  }

  /** Append text + leading newline if needed. Used by memory click-to-insert. */
  appendValue(/** @type {string} */ text) {
    if (!text) return;
    const cleaned = text.replace(/\n\[tags:[^\]]*\]\s*$/, '');
    const ta = this._textarea;
    if (!ta) return;
    const sep = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
    ta.value = ta.value + sep + cleaned;
    ta.focus();
    const pos = ta.value.length;
    ta.setSelectionRange(pos, pos);
    this._autoGrow();
  }

  focus() {
    this._textarea?.focus();
  }

  /** Clear the textarea (and run autoGrow so the height settles). */
  clear() {
    const ta = this._textarea;
    if (!ta) return;
    ta.value = '';
    this._autoGrow();
  }

  // ---- Auto-grow ---------------------------------------------------------

  _autoGrow() {
    const ta = this._textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    const border = (ta.offsetHeight - ta.clientHeight) || 0;
    ta.style.height = (ta.scrollHeight + border) + 'px';
  }

  // ---- Popup logic -------------------------------------------------------

  // Slash commands available right now: the always-on built-ins, plus any
  // tools the active worker's driver exposed via worker:list-tools
  // (toolsByWorker). Built-ins come first; worker tools are appended,
  // de-duped by id so a worker can't shadow a built-in.
  _availableSlashCommands() {
    const s = store.get();
    const out = [...BUILTIN_SLASH_COMMANDS];
    const w = s.workers.find((x) => x.id === s.currentTarget);
    const workerTools = (w && s.toolsByWorker.get(w.id)) || [];
    const seen = new Set(out.map((c) => c.id));
    for (const t of workerTools) {
      if (t && t.id && !seen.has(t.id)) { out.push(t); seen.add(t.id); }
    }
    return out;
  }

  /**
   * Decide whether a popup should be visible and what should be in it.
   * Called on every input event + after store updates.
   */
  _refreshPopup() {
    const ta = this._textarea;
    if (!ta) return;
    const text = ta.value;
    const cursor = ta.selectionStart || 0;
    const before = text.slice(0, cursor);

    // Slash mode: when `/` is the very first character of the textarea.
    // The command list is the always-on built-ins plus any active-worker
    // tools — so the popup works in every chat, not just when a tool-
    // exposing worker is attached.
    if (text.startsWith('/')) {
      const entries = this._availableSlashCommands();
      const m = text.match(/^\/([a-zA-Z0-9_-]*)/);
      const typedCmd = (m && m[1]) ? m[1].toLowerCase() : '';
      const matches = entries.filter((t) => t.id.toLowerCase().includes(typedCmd));
      this._popupMode = 'slash';
      this._matches = matches;
      if (this._slashSelected >= matches.length) this._slashSelected = Math.max(0, matches.length - 1);
      if (this._slashSelected < 0) this._slashSelected = 0;
      this.requestUpdate();
      return;
    }

    // @-mention mode. Match @prefix at end of prefix-up-to-cursor.
    const m = before.match(/(?:^|\s)@(\S*)$/);
    if (!m) {
      this._popupMode = null;
      this.requestUpdate();
      return;
    }
    const prefix = m[1].toLowerCase();
    const workers = store.get().workers;
    this._popupMode = 'mention';
    this._matches = workers
      .filter((w) => w.name.toLowerCase().includes(prefix))
      .map((w) => ({ id: w.id, name: w.name, kind: w.kind }));
    this.requestUpdate();
  }

  _hidePopup() {
    this._popupMode = null;
    this._slashSelected = 0;
  }

  /** Replace the leading `/cmd` token with `/${toolId}` keeping any args. */
  _acceptSlash(/** @type {string} */ toolId) {
    const ta = this._textarea;
    if (!ta) return;
    const text = ta.value;
    const rest = text.replace(/^\/[a-zA-Z0-9_-]*/, '');
    const next = `/${toolId}${rest.length === 0 ? ' ' : rest}`;
    ta.value = next;
    ta.focus();
    const cursor = `/${toolId}`.length + (rest.length === 0 ? 1 : 0);
    ta.setSelectionRange(cursor, cursor);
    this._hidePopup();
    this._autoGrow();
  }

  /** Replace the @prefix at the cursor with `@workerName ` and continue. */
  _acceptMention(/** @type {string} */ workerName) {
    const ta = this._textarea;
    if (!ta) return;
    const text = ta.value;
    const cursor = ta.selectionStart || 0;
    const before = text.slice(0, cursor);
    const after = text.slice(cursor);
    const head = before.replace(/(^|\s)@\S*$/, `$1@${workerName} `);
    ta.value = head + after;
    ta.focus();
    const newPos = head.length;
    ta.setSelectionRange(newPos, newPos);
    this._hidePopup();
  }

  // ---- Event handlers ----------------------------------------------------

  _onInput() {
    this._slashSelected = 0;
    this._autoGrow();
    this._refreshPopup();
  }

  _onBlur() {
    // Let mousedown on a popup item fire BEFORE we hide.
    setTimeout(() => this._hidePopup(), 100);
  }

  _onKeyDown(/** @type {KeyboardEvent} */ e) {
    const slashOpen = this._popupMode === 'slash';
    if (slashOpen && this._matches.length > 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._hidePopup();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        this._slashSelected = (this._slashSelected + dir + this._matches.length) % this._matches.length;
        this.requestUpdate();
        return;
      }
      // Tab ALWAYS accepts the highlighted command. Enter accepts only while
      // you're still picking — i.e. the textarea is just a bare `/token` with
      // no space yet. Once you've typed `/cmd <args>`, Enter SUBMITS so a
      // command like `/memory-search foo` runs instead of re-inserting `/cmd`.
      const stillPicking = /^\/[a-zA-Z0-9_-]*$/.test(this.value);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && stillPicking)) {
        e.preventDefault();
        const pick = this._matches[this._slashSelected];
        if (pick) this._acceptSlash(pick.id);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    }
  }

  _submit() {
    const text = this.value;
    if (!text.trim()) return;
    this.dispatchEvent(new CustomEvent('submit', {
      detail: { text }, bubbles: true, composed: true,
    }));
  }

  // ---- Render ------------------------------------------------------------

  _renderPopup() {
    if (!this._popupMode) return html`<div id="am-mention-popup" class="popup mention-popup mention-popup--hidden" role="listbox" hidden></div>`;
    if (this._popupMode === 'slash') {
      if (this._matches.length === 0) {
        const m = this.value.match(/^\/([a-zA-Z0-9_-]*)/);
        const typed = (m && m[1]) ? m[1].toLowerCase() : '';
        return html`
          <div id="am-mention-popup" class="popup mention-popup" role="listbox">
            <div class="item item--empty mention-item">no slash commands match "/${typed}"</div>
          </div>
        `;
      }
      return html`
        <div id="am-mention-popup" class="popup mention-popup" role="listbox">
          ${this._matches.map((t, i) => html`
            <div class=${`item item--slash mention-item mention-item--slash${i === this._slashSelected ? ' item--active mention-item--active' : ''}`}
                 data-index=${String(i)}
                 @mousedown=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); this._acceptSlash(t.id); }}>
              <div class="item__head mention-item__head">/${t.id}</div>
              ${t.description
                ? html`<div class="item__sub mention-item__sub">${(t.description || '').split(/(?<=\.)\s/)[0].slice(0, 90)}</div>`
                : ''}
            </div>
          `)}
        </div>
      `;
    }
    // @-mention mode
    if (this._matches.length === 0) {
      return html`
        <div id="am-mention-popup" class="popup mention-popup" role="listbox">
          <div class="item item--empty mention-item">no workers — spawn one first</div>
        </div>
      `;
    }
    return html`
      <div id="am-mention-popup" class="popup mention-popup" role="listbox">
        ${this._matches.map((w) => html`
          <div class="item mention-item"
               @mousedown=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); this._acceptMention(w.name); }}>
            @${w.name} (${w.kind})
          </div>
        `)}
      </div>
    `;
  }

  render() {
    return html`
      ${this._renderPopup()}
      <textarea id="am-input" rows="2" placeholder="Message your worker..." aria-label="Message"
                @input=${this._onInput}
                @keydown=${this._onKeyDown}
                @blur=${this._onBlur}></textarea>
      ${this.busy
        ? html`<button id="am-stop" class="cmd-btn cmd-btn--primary" type="button"
                       title="Stop (cancel turn)" aria-label="Stop"
                       @click=${this._cancel}>Stop</button>`
        : html`<button id="am-send" class="cmd-btn cmd-btn--primary" type="button"
                       title="Send (Enter)" aria-label="Send"
                       @click=${this._submit}>Send</button>`}
    `;
  }
}

customElements.define('compose-input', ComposeInput);
