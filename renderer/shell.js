// Multi-pane shell renderer.
//
// PaneManager owns the layout (main pane + optional extra pane), handles
// focus, and wires resize. Two controllers:
//
//   TerminalShell — runs in the main pane. Agent prompt + slash commands
//                   (/think, /shell, /shell new, /agent). Supports both
//                   modes: 'agent' (line-buffered prompt) and 'pty' (raw
//                   keystrokes routed to a PTY started in-place via /shell).
//
//   ShellPane     — runs in the additive extra pane (created by /shell new).
//                   PTY-only; when the shell exits the pane closes and
//                   focus returns to main.
//
// The transport contract is in electron/preload.js:
//   transport.run / on / health / thinkStatus / setThink / clipboard
//   transport.pty.{ start, write(paneId, data), resize(paneId, cols, rows),
//                   kill(paneId), onData(fn), onExit(fn) }
// Both pty.onData and pty.onExit fire for ALL panes; subscribers filter
// on msg.paneId.

(function () {
  const COLOR_DIM = '\x1b[90m';
  const COLOR_OK = '\x1b[32m';
  const COLOR_ERR = '\x1b[31m';
  const COLOR_TOOL = '\x1b[35m';
  const COLOR_AGENT = '\x1b[36m';
  const COLOR_SHELL = '\x1b[33m';
  const RESET = '\x1b[0m';

  const AGENT_PROMPT = `${COLOR_AGENT}agent ›${RESET} `;

  // ------------------------- TerminalShell ----------------------------
  // Main-pane controller. Has agent mode + an in-place PTY mode.

  class TerminalShell {
    constructor({ term, transport, paneId = 'main', manager }) {
      this.term = term;
      this.transport = transport;
      this.paneId = paneId;
      this.manager = manager;
      this.line = '';
      this.busy = false;
      this.sessionId = 0;
      this.think = false;
      this.mode = 'agent';
      this.unsubPty = [];
    }

    start() {
      this.term.writeln(`${COLOR_DIM}MyAgent — type a coding task and hit Enter. Files land in ./project-output/.${RESET}`);
      this.term.writeln(`${COLOR_DIM}Backend: ${this.transport.kind}${RESET}`);
      this.term.writeln(`${COLOR_DIM}Commands: /shell (terminal here), /shell new (terminal beside), /agent, /think${RESET}`);
      this.writePrompt();

      this.transport.on('chunk', ({ text }) => this.handleChunk(text));
      this.transport.on('done', (msg) => this.handleDone(msg));
      this.transport.on('error', ({ message }) => this.handleError(message));
      this.transport.on('tool-start', (info) => this.handleToolStart(info));
      this.transport.on('tool-end', (info) => this.handleToolEnd(info));

      this.term.onData((data) => this.onInput(data));

      // Clipboard: Ctrl+Shift+C copies selection, Ctrl+Shift+V pastes.
      this.term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
          this.copySelection(); return false;
        }
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
          this.pasteFromClipboard(); return false;
        }
        return true;
      });

      this.term.element?.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const sel = this.term.getSelection();
        if (sel) this.copySelection();
        else this.pasteFromClipboard();
      });

      this.term.onResize?.(({ cols, rows }) => {
        if (this.mode === 'pty' && this.transport.pty) {
          this.transport.pty.resize(this.paneId, cols, rows);
        }
      });
    }

    async copySelection() {
      const sel = this.term.getSelection();
      if (!sel) return;
      const native = this.transport.clipboard;
      try {
        if (native) native.writeText(sel);
        else await navigator.clipboard.writeText(sel);
      } catch { /* ignore */ }
    }

    async pasteFromClipboard() {
      const native = this.transport.clipboard;
      let text = '';
      try {
        text = native ? native.readText() : await navigator.clipboard.readText();
      } catch { return; }
      if (!text) return;
      if (this.mode === 'pty') {
        this.transport.pty?.write(this.paneId, text);
        return;
      }
      if (this.busy) return;
      this.onInput(text.replace(/\r?\n/g, ' '));
    }

    writePrompt() { this.term.write(`\r\n${AGENT_PROMPT}`); }

    onInput(data) {
      if (this.mode === 'pty') {
        this.transport.pty?.write(this.paneId, data);
        return;
      }
      if (this.busy) return;
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 13) this.submit();
        else if (code === 127 || code === 8) {
          if (this.line.length > 0) {
            this.line = this.line.slice(0, -1);
            this.term.write('\b \b');
          }
        } else if (code >= 32) {
          this.line += ch;
          this.term.write(ch);
        }
      }
    }

    submit() {
      const prompt = this.line.trim();
      this.line = '';
      if (!prompt) { this.writePrompt(); return; }
      if (prompt.startsWith('/')) {
        this.term.writeln('');
        this.handleSlash(prompt).then(() => {
          if (this.mode === 'agent' && !this.busy) this.writePrompt();
        });
        return;
      }
      this.busy = true;
      this.sessionId += 1;
      this.term.writeln('');
      this.term.writeln(`${COLOR_DIM}— running —${RESET}`);
      this.transport.run(String(this.sessionId), prompt);
    }

    async handleSlash(input) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      if (cmd === 'think') return this.runThink(rest);
      if (cmd === 'shell') {
        if (rest[0] === 'new') return this.openExtraShell(rest.slice(1));
        return this.enterShellModeHere(rest);
      }
      if (cmd === 'agent') {
        this.term.writeln(`${COLOR_DIM}already in agent mode${RESET}`);
        return;
      }
      this.term.writeln(`${COLOR_ERR}unknown command: /${cmd}${RESET}`);
    }

    async openExtraShell(rest) {
      if (!this.manager) {
        this.term.writeln(`${COLOR_ERR}/shell new not supported (no pane manager)${RESET}`);
        return;
      }
      try {
        await this.manager.openExtra({ cwd: rest && rest.length ? rest.join(' ') : undefined });
        this.term.writeln(`${COLOR_OK}— opened shell pane (right) — click to focus${RESET}`);
      } catch (err) {
        this.term.writeln(`${COLOR_ERR}failed to open shell pane: ${err.message || err}${RESET}`);
      }
    }

    async enterShellModeHere(rest) {
      if (!this.transport.pty) {
        this.term.writeln(`${COLOR_ERR}/shell not supported by this transport${RESET}`);
        return;
      }
      const cwd = rest && rest.length ? rest.join(' ') : undefined;
      try {
        const cols = this.term.cols;
        const rows = this.term.rows;
        const info = await this.transport.pty.start({ paneId: this.paneId, cwd, cols, rows });
        this.mode = 'pty';
        this.unsubPty.push(this.transport.pty.onData((msg) => {
          if (msg.paneId !== this.paneId) return;
          this.term.write(msg.data);
        }));
        this.unsubPty.push(this.transport.pty.onExit((msg) => {
          if (msg.paneId !== this.paneId) return;
          this.handleShellExit(msg.exitCode);
        }));
        this.term.writeln(`${COLOR_OK}— shell mode — ${info.shell || 'shell'} (pid ${info.pid})${RESET}`);
        this.term.writeln(`${COLOR_DIM}You're in a real terminal. Slash commands are disabled here.${RESET}`);
        this.term.writeln(`${COLOR_DIM}Type 'exit' or close the shell to return to agent mode.${RESET}`);
      } catch (err) {
        this.term.writeln(`${COLOR_ERR}failed to start shell: ${err.message || err}${RESET}`);
      }
    }

    handleShellExit(exitCode) {
      for (const off of this.unsubPty) { try { off(); } catch { /* ignore */ } }
      this.unsubPty = [];
      this.mode = 'agent';
      this.term.writeln('');
      this.term.writeln(`${COLOR_OK}— agent mode — (shell exited${exitCode != null ? ` with code ${exitCode}` : ''})${RESET}`);
      this.writePrompt();
    }

    async runThink(rest) {
      const arg = (rest[0] || '').toLowerCase();
      const supportsStatus = typeof this.transport.thinkStatus === 'function';
      const supportsSet = typeof this.transport.setThink === 'function';

      if (arg === 'on' || arg === 'off') {
        if (!supportsSet) {
          this.term.writeln(`${COLOR_ERR}/think not supported by this transport${RESET}`);
          return;
        }
        try {
          const res = await this.transport.setThink(arg === 'on');
          if (res && res.ok === false) {
            this.term.writeln(`${COLOR_ERR}can't set think ${arg}: ${res.reason || 'rejected'}${RESET}`);
            this.term.writeln(`${COLOR_DIM}thinking is ${res.think ? 'on' : 'off'}${RESET}`);
          } else {
            const on = res && res.think !== undefined ? res.think : arg === 'on';
            this.think = on;
            this.term.writeln(`${COLOR_OK}thinking ${on ? 'on' : 'off'}${RESET}`);
          }
        } catch (err) {
          this.term.writeln(`${COLOR_ERR}failed to set think: ${err.message || err}${RESET}`);
        }
        return;
      }

      if (!supportsStatus) {
        this.term.writeln(`${COLOR_DIM}thinking is ${this.think ? 'on' : 'off'} — usage: /think on|off${RESET}`);
        return;
      }
      try {
        const s = await this.transport.thinkStatus();
        this.think = !!s.think;
        const cap = s.capabilities && s.capabilities.thinking;
        this.term.writeln(`${COLOR_DIM}model: ${s.model || 'unknown'}${RESET}`);
        this.term.writeln(`${COLOR_DIM}thinking: ${s.think ? 'on' : 'off'}${RESET}`);
        this.term.writeln(`${COLOR_DIM}${describeCapability(cap)}${RESET}`);
      } catch (err) {
        this.term.writeln(`${COLOR_ERR}failed to read think status: ${err.message || err}${RESET}`);
      }
    }

    handleChunk(text) {
      if (this.mode !== 'agent') return;
      this.term.write(text.replace(/\n/g, '\r\n'));
    }
    handleDone(msg) {
      if (this.mode !== 'agent') return;
      this.term.writeln('');
      if (msg && msg.truncated) this.term.writeln(`${COLOR_ERR}stopped: ${msg.reason || 'truncated'}${RESET}`);
      else this.term.writeln(`${COLOR_DIM}done${RESET}`);
      this.busy = false;
      this.writePrompt();
    }
    handleError(message) {
      if (this.mode !== 'agent') return;
      this.term.writeln('');
      this.term.writeln(`${COLOR_ERR}error: ${message}${RESET}`);
      this.busy = false;
      this.writePrompt();
    }
    handleToolStart({ name, arguments: args }) {
      if (this.mode !== 'agent') return;
      this.term.writeln('');
      const argStr = args ? JSON.stringify(args) : '';
      this.term.writeln(`${COLOR_TOOL}→ ${name}(${argStr})${RESET}`);
    }
    handleToolEnd({ name, result, error }) {
      if (this.mode !== 'agent') return;
      if (error) this.term.writeln(`${COLOR_ERR}  ✗ ${error}${RESET}`);
      else this.term.writeln(`${COLOR_DIM}  ✓ ${summarizeResult(name, result)}${RESET}`);
    }
  }

  // -------------------------- ShellPane -------------------------------
  // Additive PTY-only pane created by /shell new. Closes itself on exit.

  class ShellPane {
    constructor({ term, transport, paneId = 'extra', onClose }) {
      this.term = term;
      this.transport = transport;
      this.paneId = paneId;
      this.onClose = onClose;
      this.unsub = [];
    }

    async start({ cwd } = {}) {
      this.term.onData((data) => this.transport.pty.write(this.paneId, data));

      this.term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
          this.copySelection(); return false;
        }
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
          this.paste(); return false;
        }
        return true;
      });

      this.term.element?.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const sel = this.term.getSelection();
        if (sel) this.copySelection();
        else this.paste();
      });

      this.term.onResize?.(({ cols, rows }) => {
        this.transport.pty.resize(this.paneId, cols, rows);
      });

      this.unsub.push(this.transport.pty.onData((msg) => {
        if (msg.paneId !== this.paneId) return;
        this.term.write(msg.data);
      }));
      this.unsub.push(this.transport.pty.onExit((msg) => {
        if (msg.paneId !== this.paneId) return;
        this.cleanup();
        if (this.onClose) this.onClose(msg.exitCode);
      }));

      const info = await this.transport.pty.start({
        paneId: this.paneId,
        cwd,
        cols: this.term.cols,
        rows: this.term.rows,
      });
      this.term.writeln(`${COLOR_SHELL}— shell pane — ${info.shell || 'shell'} (pid ${info.pid})${RESET}`);
      this.term.writeln(`${COLOR_DIM}Type 'exit' to close this pane.${RESET}`);
    }

    async copySelection() {
      const sel = this.term.getSelection();
      if (!sel) return;
      const native = this.transport.clipboard;
      try {
        if (native) native.writeText(sel);
        else await navigator.clipboard.writeText(sel);
      } catch { /* ignore */ }
    }
    async paste() {
      const native = this.transport.clipboard;
      let text = '';
      try { text = native ? native.readText() : await navigator.clipboard.readText(); } catch { return; }
      if (text) this.transport.pty.write(this.paneId, text);
    }

    cleanup() {
      for (const off of this.unsub) { try { off(); } catch { /* ignore */ } }
      this.unsub = [];
    }

    kill() {
      this.transport.pty.kill(this.paneId);
      this.cleanup();
    }
  }

  // -------------------------- PaneManager -----------------------------
  // Owns layout, focus, refit. Wires the main TerminalShell, lazily creates
  // the extra ShellPane.

  class PaneManager {
    constructor({ transport, panes }) {
      this.transport = transport;
      this.main = panes.main;        // { term, fit, el, paneId }
      this.extraSpec = panes.extra;  // { el, host, makeTerminal, paneId }
      this.extra = null;             // populated when /shell new opens
      this.shell = null;
      this.shellPane = null;
      this.focused = 'main';
    }

    start() {
      this.shell = new TerminalShell({
        term: this.main.term,
        transport: this.transport,
        paneId: this.main.paneId,
        manager: this,
      });
      this.shell.start();
      this.wireFocus(this.main.el, 'main');
      this.setFocus('main');
    }

    wireFocus(el, name) {
      if (!el) return;
      el.addEventListener('mousedown', () => this.setFocus(name));
    }

    setFocus(name) {
      this.focused = name;
      this.main.el?.classList.toggle('pane--focused', name === 'main');
      this.extraSpec.el?.classList.toggle('pane--focused', name === 'extra');
      const target = name === 'main' ? this.main : this.extra;
      try { target?.term?.focus(); } catch { /* ignore */ }
    }

    refitAll() {
      try { this.main.fit?.fit(); } catch { /* ignore */ }
      try { this.extra?.fit?.fit(); } catch { /* ignore */ }
    }

    async openExtra({ cwd } = {}) {
      if (this.extra) {
        // Already open — just focus it.
        this.setFocus('extra');
        return;
      }
      const { host, makeTerminal, paneId, el } = this.extraSpec;
      el.classList.remove('pane--hidden');
      const { term, fit } = makeTerminal(host);
      this.extra = { term, fit, el, paneId };
      this.wireFocus(el, 'extra');

      this.shellPane = new ShellPane({
        term,
        transport: this.transport,
        paneId,
        onClose: () => this.closeExtra(),
      });
      try {
        await this.shellPane.start({ cwd });
      } catch (err) {
        this.closeExtra();
        throw err;
      }
      // Refit after layout settles (flex sizes change when pane appears).
      setTimeout(() => this.refitAll(), 0);
      this.setFocus('extra');
    }

    closeExtra() {
      if (!this.extra) return;
      try { this.shellPane?.cleanup(); } catch { /* ignore */ }
      try { this.extra.term.dispose(); } catch { /* ignore */ }
      this.extraSpec.el.classList.add('pane--hidden');
      // Empty the host so a future /shell new gets a fresh xterm.
      if (this.extraSpec.host) this.extraSpec.host.innerHTML = '';
      this.extra = null;
      this.shellPane = null;
      setTimeout(() => this.refitAll(), 0);
      this.setFocus('main');
    }
  }

  function describeCapability(kind) {
    switch (kind) {
      case 'directive': return 'capability: directive (toggle with /think on|off — runner injects a system-prompt directive)';
      case 'flag': return 'capability: flag (toggle with /think on|off — runner sets a request-level flag)';
      case 'api-field': return 'capability: api-field (toggle with /think on|off — runner sets a vendor request field)';
      case 'always-on': return 'capability: always-on (this model always reasons; /think off will be rejected)';
      case 'never': return 'capability: never (this model has no reasoning step; /think on will be rejected)';
      case 'unknown': return 'capability: unknown (no profile for this model; /think is best-effort)';
      default: return 'capability: unspecified';
    }
  }

  function summarizeResult(name, result) {
    if (!result) return 'ok';
    if (name === 'list_dir') {
      const n = result.entries ? result.entries.length : 0;
      const more = result.truncated ? '+' : '';
      return `${n}${more} entr${n === 1 ? 'y' : 'ies'} in ${result.path}`;
    }
    if (name === 'read_file') return `read ${result.bytes} bytes from ${result.path}`;
    if (name === 'write_file') return `wrote ${result.bytes} bytes to ${result.path}`;
    return 'ok';
  }

  window.MyAgent = window.MyAgent || {};
  window.MyAgent.TerminalShell = TerminalShell;
  window.MyAgent.ShellPane = ShellPane;
  window.MyAgent.PaneManager = PaneManager;
})();
