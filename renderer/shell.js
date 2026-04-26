// Transport-agnostic terminal shell. Receives a `transport` object with:
//   transport.run(sessionId, prompt)   -> void (fire-and-forget)
//   transport.on(event, fn)            -> unsubscribe(); events: 'chunk' | 'done' | 'error'
//   transport.health()                 -> Promise<{ok, version?}>
// This means the same shell runs in Electron (preload IPC) or a future web app
// (HTTP/WebSocket transport) without changes.
//
// Exposed as window.MyAgent.TerminalShell so renderer.js can use it without
// ES module imports (kept as a classic script for Electron file:// compat
// and to avoid a build step).

(function () {
  const PROMPT = '\x1b[36m›\x1b[0m ';
  const COLOR_DIM = '\x1b[90m';
  const COLOR_OK = '\x1b[32m';
  const COLOR_ERR = '\x1b[31m';
  const COLOR_TOOL = '\x1b[35m';
  const RESET = '\x1b[0m';

  class TerminalShell {
    constructor({ term, transport }) {
      this.term = term;
      this.transport = transport;
      this.line = '';
      this.busy = false;
      this.sessionId = 0;
    }

    start() {
      this.term.writeln(`${COLOR_DIM}MyAgent — type a coding task and hit Enter. Files land in ./project-output/.${RESET}`);
      this.term.writeln(`${COLOR_DIM}Backend: ${this.transport.kind}${RESET}`);
      this.writePrompt();

      this.transport.on('chunk', ({ text }) => this.handleChunk(text));
      this.transport.on('done', (msg) => this.handleDone(msg));
      this.transport.on('error', ({ message }) => this.handleError(message));
      this.transport.on('tool-start', (info) => this.handleToolStart(info));
      this.transport.on('tool-end', (info) => this.handleToolEnd(info));

      this.term.onData((data) => this.onInput(data));

      // Clipboard: Ctrl+Shift+C copies selection, Ctrl+Shift+V pastes.
      // Returning false stops xterm from also processing the keystroke.
      this.term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
          this.copySelection();
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
          this.pasteFromClipboard();
          return false;
        }
        return true;
      });

      // Right-click pastes (matches Windows Terminal default).
      this.term.element?.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const sel = this.term.getSelection();
        if (sel) this.copySelection();
        else this.pasteFromClipboard();
      });
    }

    async copySelection() {
      const sel = this.term.getSelection();
      if (!sel) return;
      // Prefer Electron's native clipboard (always works); fall back to
      // navigator.clipboard for future web transport.
      const native = this.transport.clipboard;
      try {
        if (native) native.writeText(sel);
        else await navigator.clipboard.writeText(sel);
      } catch { /* ignore */ }
    }

    async pasteFromClipboard() {
      if (this.busy) return;
      const native = this.transport.clipboard;
      let text = '';
      try {
        text = native ? native.readText() : await navigator.clipboard.readText();
      } catch { return; }
      if (!text) return;
      // Collapse newlines so a multi-line paste lands as one editable prompt.
      this.onInput(text.replace(/\r?\n/g, ' '));
    }

    writePrompt() {
      this.term.write(`\r\n${PROMPT}`);
    }

    onInput(data) {
      if (this.busy) return;
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 13) { // Enter
          this.submit();
        } else if (code === 127 || code === 8) { // Backspace
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
      if (!prompt) {
        this.writePrompt();
        return;
      }
      this.busy = true;
      this.sessionId += 1;
      this.term.writeln('');
      this.term.writeln(`${COLOR_DIM}— running —${RESET}`);
      this.transport.run(String(this.sessionId), prompt);
    }

    handleChunk(text) {
      this.term.write(text.replace(/\n/g, '\r\n'));
    }

    handleDone(msg) {
      this.term.writeln('');
      if (msg && msg.truncated) {
        this.term.writeln(`${COLOR_ERR}stopped: ${msg.reason || 'truncated'}${RESET}`);
      } else {
        this.term.writeln(`${COLOR_DIM}done${RESET}`);
      }
      this.busy = false;
      this.writePrompt();
    }

    handleError(message) {
      this.term.writeln('');
      this.term.writeln(`${COLOR_ERR}error: ${message}${RESET}`);
      this.busy = false;
      this.writePrompt();
    }

    handleToolStart({ name, arguments: args }) {
      this.term.writeln('');
      const argStr = args ? JSON.stringify(args) : '';
      this.term.writeln(`${COLOR_TOOL}→ ${name}(${argStr})${RESET}`);
    }

    handleToolEnd({ name, result, error }) {
      if (error) {
        this.term.writeln(`${COLOR_ERR}  ✗ ${error}${RESET}`);
      } else {
        const summary = summarizeResult(name, result);
        this.term.writeln(`${COLOR_DIM}  ✓ ${summary}${RESET}`);
      }
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
})();
