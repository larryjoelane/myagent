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
import './components/app-root.js';
import './components/empty-state.js';
import './components/worker-chips.js';
import './components/settings-drawer.js';
import './components/compose-input.js';
import './components/memory-bubble.js';
import './components/chat-log.js';
import './components/topbar-commands.js';
import './components/agent-manager.js';

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
