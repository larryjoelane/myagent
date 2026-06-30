// Renderer entry point — bootstraps the terminal pane manager and the
// AgentManager chat surface. Loaded as an ES module via Vite (see
// vite.config.js). xterm + FitAddon come from npm; PaneManager is
// imported from shell.js. Importing agentManager.js for its side
// effect (it registers DOM listeners on its own).

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { PaneManager } from './shell.js';
import './agentManager.js';
// Model service host — owns the Web Worker that runs
// @huggingface/transformers (WebGPU-capable). Spawns lazily on
// first request from main. See renderer/model-bridge.js.
import './model-bridge.js';
import './components/empty-state.js';
import './components/worker-chips.js';
import './components/settings-drawer.js';
import './components/debug-drawer.js';
import './components/compose-input.js';
import './components/memory-bubble.js';
import './components/chat-log.js';
import './components/topbar-commands.js';
import './components/agent-manager.js';
import './components/file-tree.js';
// Embedded editor surface — same components the editor BrowserWindow uses,
// reused inline here when editorOpenMode = 'tab'.
import './components/file-editor.js';

const transport = window.transport;

const TERM_OPTS = {
  fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#1e1e1e', foreground: '#dcdcdc', cursor: '#dcdcdc' },
};

function makeTerminal(host) {
  const term = new Terminal(TERM_OPTS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  return { term, fit };
}

// Build the main pane immediately.
const mainHost = document.querySelector('.pane[data-pane="main"] .pane-host');
const mainPaneEl = document.querySelector('.pane[data-pane="main"]');
const extraPaneEl = document.querySelector('.pane[data-pane="extra"]');
const tabsHost = document.getElementById('tabs-host');

const main = makeTerminal(mainHost);

const manager = new PaneManager({
  transport,
  panes: {
    main: { term: main.term, fit: main.fit, el: mainPaneEl, paneId: 'main' },
    // The extra pane now owns N tabs. Manager creates per-tab hosts
    // inside `tabsHost` on demand; no single shared host.
    extra: { el: extraPaneEl, tabsHost, makeTerminal },
  },
  Terminal,
  FitAddon,
});

// Resize handling: refit whatever pane(s) are visible.
window.addEventListener('resize', () => manager.refitAll());

manager.start();
// Terminal area is hidden by default — the chat fills the window.
// Clicking + Terminal opens the area; closing the last tab hides
// it again. See PaneManager.cmdNewShell / closeTab in shell.js.

// File-tree toggle from <topbar-commands>. The tree owns its own
// open state + persistence (transport.settings.fileTreeOpen); we
// just call setOpen(!current) on click.
{
  const tree = /** @type {any} */ (document.getElementById('am-file-tree'));
  document.querySelector('topbar-commands')?.addEventListener('files-toggle', () => {
    if (!tree) return;
    void tree.setOpen?.(!tree.open);
  });
  const editorWrap = document.getElementById('editor-wrap');
  const editorTitle = document.getElementById('editor-wrap-title');
  const inlineEditor = /** @type {any} */ (document.getElementById('am-editor'));

  /** Open a file in a separate editor BrowserWindow (the original behavior). */
  function openInWindow(path) {
    try { window.transport?.editor?.openFile?.(path); }
    catch { /* ignore */ }
  }

  /** Open a file as a tab in the inline editor panel, revealing the panel. */
  function openInTab(path) {
    if (!inlineEditor) { openInWindow(path); return; }
    editorWrap?.classList.remove('editor-wrap--hidden');
    if (editorTitle) editorTitle.textContent = basenameOf(path);
    try { inlineEditor.openFile(path); }
    catch { openInWindow(path); }
  }

  function basenameOf(p) {
    const parts = String(p || '').split(/[\\/]/);
    return parts[parts.length - 1] || 'Editor';
  }

  // Read the persisted open-mode each time (cheap; lets a Settings change
  // take effect without reloading). Default 'window' preserves prior UX.
  async function currentOpenMode() {
    try {
      const r = await window.transport?.settings?.get?.('editorOpenMode', 'window');
      return r?.value === 'tab' ? 'tab' : 'window';
    } catch { return 'window'; }
  }

  // file-open is dispatched (bubbles, composed) from inside the file-tree's
  // shadow root on a plain file click. Route per the editorOpenMode setting.
  document.addEventListener('file-open', async (/** @type {any} */ ev) => {
    const path = ev?.detail?.path;
    if (!path) return;
    const mode = await currentOpenMode();
    if (mode === 'tab') openInTab(path);
    else openInWindow(path);
  });

  // file-open-window is the right-click "Open in new window" override —
  // always a separate BrowserWindow regardless of the setting.
  document.addEventListener('file-open-window', (/** @type {any} */ ev) => {
    const path = ev?.detail?.path;
    if (path) openInWindow(path);
  });

  // file-open-tab is the right-click "Open in tab" override — always inline.
  document.addEventListener('file-open-tab', (/** @type {any} */ ev) => {
    const path = ev?.detail?.path;
    if (path) openInTab(path);
  });

  const appRow = document.getElementById('app-row');
  const maxBtn = document.getElementById('editor-wrap-max');

  // Maximize: hide the chat + terminal so the editor fills the row. The
  // file-tree rail stays so you can still open other files.
  maxBtn?.addEventListener('click', () => {
    const max = appRow?.classList.toggle('app-row--editor-max');
    maxBtn.setAttribute('aria-pressed', max ? 'true' : 'false');
  });

  document.getElementById('editor-wrap-close')?.addEventListener('click', () => {
    // Closing the panel closes its tabs too, dropping their in-memory
    // buffers — otherwise a later re-open would resurrect a stale buffer
    // and not reflect on-disk changes. If a tab has unsaved edits and the
    // user cancels the discard prompt, keep the panel open.
    if (inlineEditor?.closeAll && inlineEditor.closeAll() === false) return;
    editorWrap?.classList.add('editor-wrap--hidden');
    // Closing the panel must also drop maximize, or the chat/terminal
    // would stay hidden with nothing visible in their place.
    appRow?.classList.remove('app-row--editor-max');
    maxBtn?.setAttribute('aria-pressed', 'false');
  });
}
