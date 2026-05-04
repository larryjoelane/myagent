// @ts-check
// <topbar-commands> — the four command buttons in the app header
// (Chat / + Terminal / + Browser / Close).
//
// Light-DOM LitElement: we keep the existing button ids (cmd-agent-manager,
// cmd-new-shell, cmd-new-browser, cmd-close-pane) in the document tree so
// the global .cmd-btn styles in style.css apply, and so e2e tests that
// click #cmd-new-shell / #cmd-close-pane keep working unchanged.
//
// API:
//   property closePaneDisabled: boolean    — drives the Close button's :disabled
//
// Events (bubbling, composed):
//   chat-toggle    — Chat button clicked
//   new-shell      — + Terminal clicked
//   new-browser    — + Browser clicked
//   close-pane     — Close clicked

import { LitElement, html } from 'lit';

export class TopbarCommands extends LitElement {
  // Light DOM — see file header.
  createRenderRoot() { return this; }

  static properties = {
    closePaneDisabled: { type: Boolean, attribute: 'close-pane-disabled', reflect: true },
  };

  constructor() {
    super();
    this.closePaneDisabled = true;
  }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add('commands');
    this.setAttribute('aria-label', 'Commands');
  }

  _emit(name) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  render() {
    return html`
      <button id="cmd-agent-manager" class="cmd-btn cmd-btn--primary" type="button"
              title="Toggle chat (Ctrl+Shift+A)"
              @click=${() => this._emit('chat-toggle')}>Chat</button>
      <button id="cmd-new-shell" class="cmd-btn" type="button"
              title="New terminal tab (Ctrl+Shift+T)"
              @click=${() => this._emit('new-shell')}>+ Terminal</button>
      <button id="cmd-new-browser" class="cmd-btn" type="button"
              title="New browser tab"
              @click=${() => this._emit('new-browser')}>+ Browser</button>
      <button id="cmd-close-pane" class="cmd-btn" type="button"
              title="Close terminal tab (Ctrl+Shift+W)"
              ?disabled=${this.closePaneDisabled}
              @click=${() => this._emit('close-pane')}>Close</button>
    `;
  }
}

customElements.define('topbar-commands', TopbarCommands);
