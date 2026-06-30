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
//   files-toggle   — Files button clicked (toggles the <file-tree> rail)
//   new-shell      — + Terminal clicked
//   new-browser    — + Browser clicked
//   close-pane     — Close clicked

import { LitElement, html } from 'lit';

export class TopbarCommands extends LitElement {
  // Light DOM — see file header.
  createRenderRoot() { return this; }

  static properties = {
    closePaneDisabled: { type: Boolean, attribute: 'close-pane-disabled', reflect: true },
    /** Dev-only: shows the 📷 screenshot button. Set from capture.isDev(). */
    _isDev: { state: true },
    /** Transient label flashed on the camera button after a capture. */
    _shotFlash: { state: true },
  };

  constructor() {
    super();
    this.closePaneDisabled = true;
    this._isDev = false;
    this._shotFlash = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add('commands');
    this.setAttribute('aria-label', 'Commands');
    // Ask main whether this is a dev/from-source run; only then do we
    // render the screenshot button. Packaged builds never show it.
    const t = /** @type {any} */ (window).transport;
    t?.capture?.isDev?.().then((r) => { this._isDev = !!(r && r.isDev); }).catch(() => {});
  }

  async _onScreenshot() {
    const t = /** @type {any} */ (window).transport;
    if (!t?.capture?.screenshot) return;
    let r;
    try { r = await t.capture.screenshot({}); }
    catch (err) { r = { ok: false, error: err?.message || String(err) }; }
    if (r && r.ok) {
      const name = String(r.path || '').split(/[\\/]/).pop();
      this._shotFlash = `✓ ${name}`;
    } else {
      this._shotFlash = `✗ ${(r && (r.error || r.reason)) || 'failed'}`;
    }
    // Clear the flash after a moment so the button returns to 📷.
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this._shotFlash = ''; }, 2200);
  }

  _emit(name) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  render() {
    return html`
      <button id="cmd-agent-manager" class="cmd-btn cmd-btn--primary" type="button"
              title="Toggle chat (Ctrl+Shift+A)"
              @click=${() => this._emit('chat-toggle')}>Chat</button>
      <button id="cmd-files" class="cmd-btn" type="button"
              title="Toggle file explorer"
              @click=${() => this._emit('files-toggle')}>Files</button>
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
      ${this._isDev ? html`
        <button id="cmd-screenshot" class="cmd-btn" type="button"
                title="Capture a screenshot of this window → docs/screenshots/ (dev only)"
                @click=${() => this._onScreenshot()}>${this._shotFlash || '📷'}</button>
      ` : ''}
    `;
  }
}

customElements.define('topbar-commands', TopbarCommands);
