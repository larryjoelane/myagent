// Entry point — runs after vendor scripts (xterm, addon-fit) and shell.js.
// Uses globals (window.Terminal, window.FitAddon, window.MyAgent.TerminalShell)
// because Electron's file:// loader doesn't resolve bare or relative ESM
// imports reliably across versions. This also keeps the renderer trivially
// portable to a static-served web app later (no build step required).

(function () {
  const transport = window.transport;

  // xterm.js UMD attaches its export differently across versions:
  //   - some builds set window.Terminal directly
  //   - others namespace it under window.xterm.Terminal
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

  const term = new Terminal({
    fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#dcdcdc',
      cursor: '#dcdcdc',
    },
  });

  if (FitAddon) {
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));
    fit.fit();
    window.addEventListener('resize', () => fit.fit());
  } else {
    term.open(document.getElementById('terminal'));
  }

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

  const shell = new window.MyAgent.TerminalShell({ term, transport });
  shell.start();
  refreshHealth();
})();
