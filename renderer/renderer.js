// Entry point — runs after vendor scripts (xterm, addon-fit) and shell.js.
// Uses globals (window.Terminal, window.FitAddon, window.MyAgent.*)
// because Electron's file:// loader doesn't resolve bare or relative ESM
// imports reliably across versions. This also keeps the renderer trivially
// portable to a static-served web app later (no build step required).

(function () {
  const transport = window.transport;

  const Terminal =
    window.Terminal ||
    (window.xterm && window.xterm.Terminal) ||
    (window.xtermjs && window.xtermjs.Terminal);
  const FitAddon =
    (window.FitAddon && window.FitAddon.FitAddon) ||
    window.FitAddon ||
    (window.xtermAddonFit && window.xtermAddonFit.FitAddon);

  if (!Terminal) {
    document.body.innerHTML =
      '<pre style="color:#f88;padding:16px;font-family:monospace">' +
      'failed to load xterm.js — vendor file missing or wrong global. ' +
      'check renderer/vendor/xterm.js exists.</pre>';
    return;
  }

  const TERM_OPTS = {
    fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#1e1e1e', foreground: '#dcdcdc', cursor: '#dcdcdc' },
  };

  function makeTerminal(host) {
    const term = new Terminal(TERM_OPTS);
    let fit = null;
    if (FitAddon) {
      fit = new FitAddon();
      term.loadAddon(fit);
    }
    term.open(host);
    if (fit) fit.fit();
    return { term, fit };
  }

  // Build the main pane immediately.
  const mainHost = document.querySelector('.pane[data-pane="main"] .pane-host');
  const extraHost = document.querySelector('.pane[data-pane="extra"] .pane-host');
  const mainPaneEl = document.querySelector('.pane[data-pane="main"]');
  const extraPaneEl = document.querySelector('.pane[data-pane="extra"]');

  const main = makeTerminal(mainHost);

  const manager = new window.MyAgent.PaneManager({
    transport,
    panes: {
      main: { term: main.term, fit: main.fit, el: mainPaneEl, paneId: 'main' },
      extra: { term: null, fit: null, el: extraPaneEl, paneId: 'extra', host: extraHost, makeTerminal },
    },
    Terminal,
    FitAddon,
  });

  // Resize handling: refit whatever pane(s) are visible.
  window.addEventListener('resize', () => manager.refitAll());

  // Health badge wired off the main transport (agent stays in main pane).
  const statusEl = document.getElementById('status');
  async function refreshHealth() {
    try {
      const h = await transport.health();
      if (h.ok) {
        statusEl.textContent = `ollama ${h.version || ''}`.trim();
        statusEl.className = 'status status--ok';
      } else {
        statusEl.textContent = h.reason ? `ollama: ${h.reason}` : 'ollama down';
        statusEl.className = 'status status--down';
      }
      return h;
    } catch (err) {
      statusEl.textContent = `ollama: ${err && err.message ? err.message : 'down'}`;
      statusEl.className = 'status status--down';
      return { ok: false };
    }
  }

  manager.start();
  refreshHealth();
})();
