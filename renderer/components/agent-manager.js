// @ts-check
// <agent-manager> — the chat surface shell. Wraps the entire <aside>
// that hosts settings-drawer, worker-chips, empty-state, chat-log,
// and compose-input. Owns:
//
//   - the `agent-manager--hidden` visibility toggle (driven by the
//     `open` boolean property)
//   - the header (title + settings ⚙ + close ×)
//   - the settings ⚙ button → toggles the slotted <settings-drawer>'s
//     `open` property + the legacy `agent-manager__settings--hidden`
//     class on the drawer host (e2e tests check both)
//
// Light-DOM LitElement so:
//   - the host id stays "agent-manager" for `document.getElementById`
//     and Playwright `#agent-manager` selectors
//   - the inner button ids (am-settings-toggle, agent-manager-close)
//     remain queryable
//   - the slotted children render at the document level (where their
//     own light/shadow DOM choices already work)
//
// Public API:
//   .open: boolean                — visibility (host class toggles)
//   .settingsOpen: boolean        — drawer state (read/write)
//   event 'close'                 — × button clicked
//   event 'settings-toggled'      — ⚙ clicked; detail.open: boolean
//
// agentManager.js no longer needs to query rootEl/settingsEl; it
// listens to events and sets properties.

import { LitElement, html } from 'lit';

export class AgentManagerShell extends LitElement {
  // Light DOM — see file header.
  createRenderRoot() { return this; }

  static properties = {
    open: { type: Boolean, reflect: false },
    settingsOpen: { type: Boolean, reflect: false },
    debugOpen: { type: Boolean, reflect: false },
  };

  constructor() {
    super();
    this.open = true;
    this.settingsOpen = false;
    this.debugOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add('agent-manager');
    this.setAttribute('aria-label', 'Chat');
    this._applyOpen();
  }

  // We render a header into a light-DOM child plus rely on slotted
  // existing children (settings-drawer, worker-chips, etc.) being
  // appended by index.html. The render() output replaces light DOM
  // children, so we render the header ONCE at first connect and
  // keep the rest of the children intact below it.
  //
  // Strategy: insert the header as the first child if it isn't there
  // yet. This avoids using <slot> (which only works in shadow DOM)
  // while preserving the original child order.
  firstUpdated() {
    this._ensureHeader();
  }

  updated(changed) {
    if (changed.has('open')) this._applyOpen();
    if (changed.has('settingsOpen')) this._applySettingsOpen();
    if (changed.has('debugOpen')) this._applyDebugOpen();
  }

  _ensureHeader() {
    if (this.querySelector('.agent-manager__header')) return;
    const header = document.createElement('div');
    header.className = 'agent-manager__header';

    const title = document.createElement('span');
    title.className = 'agent-manager__title';
    title.textContent = 'Chat';
    header.appendChild(title);

    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'am-settings-toggle';
    settingsBtn.className = 'agent-manager__icon-btn';
    settingsBtn.type = 'button';
    settingsBtn.title = 'Settings (memory mirror, workers)';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.textContent = '⚙';
    settingsBtn.addEventListener('click', () => this._toggleSettings());
    header.appendChild(settingsBtn);

    const debugBtn = document.createElement('button');
    debugBtn.id = 'am-debug-toggle';
    debugBtn.className = 'agent-manager__icon-btn';
    debugBtn.type = 'button';
    debugBtn.title = 'Debug (live event stream — Ctrl+Shift+D)';
    debugBtn.setAttribute('aria-label', 'Debug');
    // Bug glyph. Plain ASCII fallback if the font lacks the codepoint
    // is the empty string, which is acceptable — the title still works.
    debugBtn.textContent = '🐞';
    debugBtn.addEventListener('click', () => this._toggleDebug());
    header.appendChild(debugBtn);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'agent-manager-close';
    closeBtn.className = 'agent-manager__icon-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Hide chat';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      this.open = false;
      this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    });
    header.appendChild(closeBtn);

    this.insertBefore(header, this.firstChild);
  }

  _toggleSettings(force) {
    this.settingsOpen = (force == null) ? !this.settingsOpen : !!force;
    this.dispatchEvent(new CustomEvent('settings-toggled', {
      bubbles: true, composed: true,
      detail: { open: this.settingsOpen },
    }));
  }

  _toggleDebug(force) {
    this.debugOpen = (force == null) ? !this.debugOpen : !!force;
    this.dispatchEvent(new CustomEvent('debug-toggled', {
      bubbles: true, composed: true,
      detail: { open: this.debugOpen },
    }));
  }

  _applyOpen() {
    this.classList.toggle('agent-manager--hidden', !this.open);
  }

  _applySettingsOpen() {
    const drawer = this.querySelector('settings-drawer');
    if (!drawer) return;
    /** @type {any} */ (drawer).open = this.settingsOpen;
    drawer.classList.toggle('agent-manager__settings--hidden', !this.settingsOpen);
  }

  _applyDebugOpen() {
    const drawer = this.querySelector('debug-drawer');
    if (!drawer) return;
    /** @type {any} */ (drawer).open = this.debugOpen;
  }

  // render() is a no-op — children come from light-DOM authoring in
  // index.html; the header is injected once in firstUpdated.
  render() { return html``; }
}

customElements.define('agent-manager', AgentManagerShell);
