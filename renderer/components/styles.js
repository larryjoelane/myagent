// @ts-check
// Shared style fragments imported into multiple components. Lit's css``
// tagged template returns a CSSResult that can be composed via the
// static styles array (see Lit docs on "Sharing Styles").
//
// Why duplicate-feeling? Shadow DOM doesn't inherit page-level styles,
// so any rule a component needs has to be either declared here or in
// the component's own static styles. CSS variables (--text, --accent,
// etc.) DO cross the shadow boundary and live in style.css :root —
// don't redefine them here.

import { css } from 'lit';

/** Standard command button (.cmd-btn + variants). */
export const cmdBtnStyles = css`
  .cmd-btn {
    background: #3a3a3a;
    color: var(--text);
    border: 1px solid #4a4a4a;
    border-radius: 3px;
    padding: 3px 10px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background 80ms ease, border-color 80ms ease;
  }
  .cmd-btn:hover:not(:disabled) {
    background: #4a4a4a;
    border-color: var(--accent);
  }
  .cmd-btn:active:not(:disabled) { background: var(--surface-3); }
  .cmd-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .cmd-btn--primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .cmd-btn--primary:hover:not(:disabled) {
    background: #4a8ec5;
    border-color: #4a8ec5;
  }
  .cmd-btn--muted {
    background: transparent;
    border-color: transparent;
    color: var(--text-dim);
  }
  .cmd-btn--muted:hover:not(:disabled) {
    background: var(--surface-3);
    border-color: transparent;
  }
  .cmd-btn--small { padding: 2px 6px; font-size: 11px; }
  .cmd-btn--active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
`;
