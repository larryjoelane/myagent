// @ts-check
// <app-root> — the eventual root container for the chat surface.
//
// Today this is a smoke element: it just confirms Lit + Vite + the
// custom-element registry are all wired up. As we componentize
// agentManager.js (step C), the chat UI will move into here piece by
// piece. Use as: <app-root></app-root>.
//
// Web-component compatible — anyone embedding the app, or loading other
// component libraries, can drop this in without a framework wrapper.

import { LitElement, html, css } from 'lit';

export class AppRoot extends LitElement {
  static styles = css`
    :host {
      display: block;
      font: 11px/1.4 'Cascadia Code', Consolas, Menlo, monospace;
      color: #888;
      padding: 4px 8px;
    }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      background: #2a2a2a;
      color: #6ec1ff;
      letter-spacing: 0.04em;
    }
  `;

  render() {
    return html`<span class="badge">lit ✓</span>`;
  }
}

customElements.define('app-root', AppRoot);
