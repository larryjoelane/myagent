// Multi-pane shell renderer.
//
// PaneManager owns the layout (main pane + tabbed extra pane), handles
// focus, and wires resize. Two controllers:
//
//   TerminalShell — runs in the main pane. Boots into a real PTY; when
//                   the shell exits the pane drops into 'command' mode
//                   where slash commands (/shell, /help) work. Agent
//                   integration is intentionally absent — to be added
//                   later.
//
//   ShellPane     — runs in each side-pane tab (created by New Shell /
//                   Ctrl+Shift+T). PTY-only; when the shell exits its
//                   tab closes.
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
  const COLOR_SHELL = '\x1b[33m';
  const RESET = '\x1b[0m';

  const COMMAND_PROMPT = `${COLOR_DIM}MyAgent ›${RESET} `;

  // ------------------------- TerminalShell ----------------------------
  // Main-pane controller. Boots into a PTY; on exit, drops into 'command'
  // mode (slash commands only).

  class TerminalShell {
    constructor({ term, transport, paneId = 'main', manager }) {
      this.term = term;
      this.transport = transport;
      this.paneId = paneId;
      this.manager = manager;
      this.line = '';
      // Modes:
      //   'pty'     — real shell. Raw input, slash commands NOT
      //               intercepted; they run as shell commands.
      //   'command' — entered when the PTY exits. Slash-command-only
      //               prompt; type /shell to spawn a new PTY.
      this.mode = 'pty';
      this.unsubPty = [];
    }

    start() {
      this.term.writeln(`${COLOR_DIM}MyAgent — boots into a real terminal.${RESET}`);
      this.term.writeln(`${COLOR_DIM}Type 'exit' to leave the shell, then /shell to start a new one or /help for more.${RESET}`);
      this.term.writeln(`${COLOR_DIM}Backend: ${this.transport.kind}${RESET}`);

      this.term.onData((data) => this.onInput(data));

      // Boot directly into a PTY so the user lands in a real shell. Defer
      // one paint cycle so the terminal has settled into its final
      // dimensions before we tell the PTY what cols/rows to spawn at.
      requestAnimationFrame(() => this.enterShellModeHere([]));

      // Clipboard: Ctrl+Shift+C copies selection, Ctrl+Shift+V pastes.
      // Other hotkeys (Ctrl+Shift+T/W for pane management) are handled
      // globally at the document level by PaneManager — see start().
      this.term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (!(ev.ctrlKey && ev.shiftKey)) return true;
        const k = ev.key.toLowerCase();
        if (k === 'c') { this.copySelection(); return false; }
        if (k === 'v') { this.pasteFromClipboard(); return false; }
        // Swallow T/W so xterm doesn't pass them to the PTY child even
        // though our document-level keydown will fire first; belt and
        // suspenders against ordering surprises.
        if (k === 't' || k === 'w') return false;
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
      // Command mode — feed each char through the line editor.
      this.onInput(text.replace(/\r?\n/g, ' '));
    }

    writePrompt() { this.term.write(`\r\n${COMMAND_PROMPT}`); }

    onInput(data) {
      // PTY mode forwards keystrokes raw to the child process. Slash
      // commands are NOT intercepted here — type 'exit' to leave the shell.
      if (this.mode === 'pty') {
        this.transport.pty?.write(this.paneId, data);
        return;
      }
      // Command mode is line-buffered.
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
          // Re-prompt unless a slash command transitioned us into PTY
          // mode (PTY paints its own prompt).
          if (this.mode !== 'pty') this.writePrompt();
        });
        return;
      }
      // Plain text isn't meaningful in command mode.
      this.term.writeln('');
      this.term.writeln(`${COLOR_DIM}command mode — type /shell for a new terminal, or /help${RESET}`);
    }

    async handleSlash(input) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      if (cmd === 'shell') {
        if (rest[0] === 'new') return this.openExtraShell(rest.slice(1));
        return this.enterShellModeHere(rest);
      }
      if (cmd === 'help' || cmd === '?') return this.printHelp();
      this.term.writeln(`${COLOR_ERR}unknown command: /${cmd}${RESET}`);
    }

    printHelp() {
      this.term.writeln(`${COLOR_DIM}Available commands:${RESET}`);
      this.term.writeln(`${COLOR_DIM}  /shell                            Start a new terminal here${RESET}`);
      this.term.writeln(`${COLOR_DIM}  /shell new                        Open a terminal tab in the side pane${RESET}`);
      this.term.writeln(`${COLOR_DIM}  /help                             Show this help${RESET}`);
    }

    async openExtraShell(rest) {
      if (!this.manager) {
        this.term.writeln(`${COLOR_ERR}/shell new not supported (no pane manager)${RESET}`);
        return;
      }
      try {
        await this.manager.openTab({ cwd: rest && rest.length ? rest.join(' ') : undefined });
        this.term.writeln(`${COLOR_OK}— opened shell tab — click the tab bar to switch${RESET}`);
      } catch (err) {
        this.term.writeln(`${COLOR_ERR}failed to open shell tab: ${err.message || err}${RESET}`);
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
        this.term.writeln(`${COLOR_DIM}Slash commands are disabled here. Type 'exit' to leave the shell.${RESET}`);
      } catch (err) {
        this.term.writeln(`${COLOR_ERR}failed to start shell: ${err.message || err}${RESET}`);
      }
    }

    // Called when the PTY child exits (user typed 'exit', Ctrl-D, etc.).
    // We land in 'command' mode — slash commands work, plain text doesn't.
    handleShellExit(exitCode) {
      for (const off of this.unsubPty) { try { off(); } catch { /* ignore */ } }
      this.unsubPty = [];
      this.mode = 'command';
      this.term.writeln('');
      this.term.writeln(`${COLOR_OK}— shell exited${exitCode != null ? ` (code ${exitCode})` : ''} — command mode${RESET}`);
      this.term.writeln(`${COLOR_DIM}/shell    start a new terminal${RESET}`);
      this.term.writeln(`${COLOR_DIM}/help     list all commands${RESET}`);
      this.writePrompt();
    }
  }

  // -------------------------- ShellPane -------------------------------
  // Additive PTY-only pane created by /shell new. Closes itself on exit.

  class ShellPane {
    constructor({ term, transport, paneId = 'extra', onClose, manager }) {
      this.term = term;
      this.transport = transport;
      this.paneId = paneId;
      this.onClose = onClose;
      this.manager = manager;
      this.unsub = [];
    }

    async start({ cwd } = {}) {
      this.term.onData((data) => this.transport.pty.write(this.paneId, data));

      this.term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (!(ev.ctrlKey && ev.shiftKey)) return true;
        const k = ev.key.toLowerCase();
        if (k === 'c') { this.copySelection(); return false; }
        if (k === 'v') { this.paste(); return false; }
        // Swallow T/W — global document-level handler in PaneManager
        // takes care of the action; we just keep them away from the PTY.
        if (k === 't' || k === 'w') return false;
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

  // -------------------------- BrowserPane -----------------------------
  // Owns a tab whose body is an Electron BrowserView (out-of-DOM Chromium
  // widget). The renderer just reserves a rectangle (the .browser-host
  // element) and reports its bounds to the main process; the BrowserView
  // is layered on top. Hide/show maps to detach/attach.

  class BrowserPane {
    constructor({ transport, tabId, hostEl, onTitle, onLoading }) {
      this.transport = transport;
      this.tabId = tabId;
      this.hostEl = hostEl;
      this.onTitle = onTitle || (() => {});
      this.onLoading = onLoading || (() => {});
      this.unsub = [];
      this.boundsObserver = null;
      this.canGoBack = false;
      this.canGoForward = false;
      this.currentURL = '';
      this.urlInput = null;
      this.backBtn = null;
      this.forwardBtn = null;
      this.reloadBtn = null;
    }

    // Build the chrome (URL bar + back/forward/reload + body host) and
    // create the BrowserView. Reports initial bounds after the host
    // element has a non-zero rect.
    async start({ initialURL } = {}) {
      this._buildChrome();

      const { ok, error } = await this.transport.browser.create({
        tabId: this.tabId,
        url: initialURL,
      });
      if (!ok) throw new Error(error || 'browser:create failed');

      // Start observing the body host so window/pane resize keeps the
      // BrowserView aligned. ResizeObserver fires on initial layout too.
      this.boundsObserver = new ResizeObserver(() => this._reportBounds());
      this.boundsObserver.observe(this.bodyEl);
      // Window scroll/resize: the host's getBoundingClientRect changes
      // even if its size didn't, so reposition on those too.
      this._onWinResize = () => this._reportBounds();
      window.addEventListener('resize', this._onWinResize);
      // Mutations on #app-row (e.g. chat panel toggling its hidden
      // class) shift the body's screen position without changing its
      // size, so ResizeObserver alone misses them.
      const appRow = document.getElementById('app-row');
      if (appRow) {
        this.mutationObserver = new MutationObserver(() => this._reportBounds());
        this.mutationObserver.observe(appRow, {
          attributes: true,
          attributeFilter: ['class', 'style'],
          subtree: true,
        });
      }

      this.unsub.push(this.transport.browser.on('browser:nav', (msg) => {
        if (msg.tabId !== this.tabId) return;
        this.currentURL = msg.url;
        this.canGoBack = !!msg.canGoBack;
        this.canGoForward = !!msg.canGoForward;
        if (this.urlInput && document.activeElement !== this.urlInput) {
          this.urlInput.value = msg.url;
        }
        if (this.backBtn) this.backBtn.disabled = !this.canGoBack;
        if (this.forwardBtn) this.forwardBtn.disabled = !this.canGoForward;
      }));
      this.unsub.push(this.transport.browser.on('browser:title', (msg) => {
        if (msg.tabId !== this.tabId) return;
        this.onTitle(msg.title);
      }));
      this.unsub.push(this.transport.browser.on('browser:loading', (msg) => {
        if (msg.tabId !== this.tabId) return;
        if (this.reloadBtn) this.reloadBtn.textContent = msg.loading ? '×' : '⟳';
        this.onLoading(msg.loading);
      }));
      this.unsub.push(this.transport.browser.on('browser:error', (msg) => {
        if (msg.tabId !== this.tabId) return;
        // Surface load errors as a tiny inline banner. Auto-clears on
        // next successful nav.
        this._showError(`${msg.errorDescription || 'load failed'}`);
      }));

      // Initial bounds — ResizeObserver fires on first observe but only
      // after the next layout. Force one now so the view doesn't flash.
      requestAnimationFrame(() => this._reportBounds());
    }

    _buildChrome() {
      this.hostEl.classList.add('browser-pane');
      const bar = document.createElement('div');
      bar.className = 'browser-bar';

      this.backBtn = document.createElement('button');
      this.backBtn.className = 'browser-btn';
      this.backBtn.type = 'button';
      this.backBtn.title = 'Back';
      this.backBtn.textContent = '←';
      this.backBtn.disabled = true;
      this.backBtn.addEventListener('click', () => this.transport.browser.back(this.tabId));

      this.forwardBtn = document.createElement('button');
      this.forwardBtn.className = 'browser-btn';
      this.forwardBtn.type = 'button';
      this.forwardBtn.title = 'Forward';
      this.forwardBtn.textContent = '→';
      this.forwardBtn.disabled = true;
      this.forwardBtn.addEventListener('click', () => this.transport.browser.forward(this.tabId));

      this.reloadBtn = document.createElement('button');
      this.reloadBtn.className = 'browser-btn';
      this.reloadBtn.type = 'button';
      this.reloadBtn.title = 'Reload';
      this.reloadBtn.textContent = '⟳';
      this.reloadBtn.addEventListener('click', () => {
        // If currently loading, the button shows '×' for stop.
        if (this.reloadBtn.textContent === '×') this.transport.browser.stop(this.tabId);
        else this.transport.browser.reload(this.tabId);
      });

      this.urlInput = document.createElement('input');
      this.urlInput.className = 'browser-url';
      this.urlInput.type = 'text';
      this.urlInput.placeholder = 'Enter URL or search...';
      this.urlInput.spellcheck = false;
      this.urlInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const v = this.urlInput.value.trim();
          if (v) this.transport.browser.loadURL(this.tabId, v);
        }
      });
      this.urlInput.addEventListener('focus', () => this.urlInput.select());

      bar.appendChild(this.backBtn);
      bar.appendChild(this.forwardBtn);
      bar.appendChild(this.reloadBtn);
      bar.appendChild(this.urlInput);

      this.errorBar = document.createElement('div');
      this.errorBar.className = 'browser-error browser-error--hidden';

      this.bodyEl = document.createElement('div');
      this.bodyEl.className = 'browser-body';

      this.hostEl.appendChild(bar);
      this.hostEl.appendChild(this.errorBar);
      this.hostEl.appendChild(this.bodyEl);
    }

    _showError(msg) {
      if (!this.errorBar) return;
      this.errorBar.textContent = msg;
      this.errorBar.classList.remove('browser-error--hidden');
      clearTimeout(this._errorTimer);
      this._errorTimer = setTimeout(() => {
        this.errorBar.classList.add('browser-error--hidden');
      }, 4000);
    }

    _reportBounds() {
      if (!this.bodyEl) return;
      const rect = this.bodyEl.getBoundingClientRect();
      this.transport.browser.setBounds(this.tabId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }

    show() {
      this.transport.browser.show(this.tabId);
      // Bounds may have shifted while hidden (e.g. window resized).
      requestAnimationFrame(() => this._reportBounds());
    }

    hide() {
      this.transport.browser.hide(this.tabId);
    }

    refit() { this._reportBounds(); }

    cleanup() {
      for (const off of this.unsub) { try { off(); } catch { /* ignore */ } }
      this.unsub = [];
      try { this.boundsObserver?.disconnect(); } catch { /* ignore */ }
      this.boundsObserver = null;
      try { this.mutationObserver?.disconnect(); } catch { /* ignore */ }
      this.mutationObserver = null;
      if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
      this._onWinResize = null;
    }

    async destroy() {
      this.cleanup();
      try { await this.transport.browser.destroy(this.tabId); } catch { /* ignore */ }
    }
  }

  // -------------------------- PaneManager -----------------------------
  // Owns layout, focus, refit. Wires the main TerminalShell, lazily creates
  // the extra ShellPane.

  class PaneManager {
    constructor({ transport, panes }) {
      this.transport = transport;
      this.main = panes.main;        // { term, fit, el, paneId }
      this.extraSpec = panes.extra;  // { el, tabsHost, makeTerminal }
      this.shell = null;
      this.focused = 'main';
      this.splitter = null;          // SplitterDrag controller
      // Tab state. Each entry:
      //   { paneId, term, fit, hostEl, tabEl, labelEl, shellPane, label, cwd }
      // The active tab's hostEl has class `tab-host--active`; others are
      // hidden but still alive (PTY running, scrollback intact).
      this.tabs = [];
      this.activeTabId = null;
      this.tabSeq = 0;               // monotonic counter for paneId
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

      // + Browser button on the topbar opens a new browser tab in the
      // extra pane (same place + Terminal puts shell tabs).
      const btnNewBrowser = document.getElementById('cmd-new-browser');
      btnNewBrowser?.addEventListener('click', () => {
        this.openBrowserTab({}).catch((err) => {
          console.error('openBrowserTab failed', err);
        });
      });

      // Splitter is part of the layout but starts hidden until /shell new
      // opens the extra pane.
      const splitterEl = document.getElementById('splitter');
      if (splitterEl) {
        this.splitter = new SplitterDrag({
          element: splitterEl,
          mainPaneEl: this.main.el,
          extraPaneEl: this.extraSpec.el,
          onResize: () => this.refitAll(),
        });
      }

      // Top-bar command buttons. The same actions are also reachable via
      // the global hotkeys wired further down — both call into these
      // methods so the behavior stays consistent.
      const btnNewShell = document.getElementById('cmd-new-shell');
      const btnClosePane = document.getElementById('cmd-close-pane');
      btnNewShell?.addEventListener('click', () => this.cmdNewShell());
      btnClosePane?.addEventListener('click', () => this.cmdClosePane());
      this.btnClosePane = btnClosePane;
      this.updateCommandButtons();

      // Global hotkeys — Ctrl+Shift+T/W and Ctrl+Tab cycling. Captured
      // at document level so they fire regardless of which pane is
      // focused (or whether the active pane is in PTY mode where
      // slashes go to the shell).
      document.addEventListener('keydown', (ev) => {
        if (ev.ctrlKey && ev.shiftKey) {
          const k = ev.key.toLowerCase();
          if (k === 't') { ev.preventDefault(); this.cmdNewShell(); return; }
          if (k === 'w') { ev.preventDefault(); this.cmdClosePane(); return; }
        }
        // Ctrl+Tab / Ctrl+Shift+Tab — cycle through extra-pane tabs.
        if (ev.ctrlKey && ev.key === 'Tab') {
          if (this.tabs.length > 1) {
            ev.preventDefault();
            this.cycleTab(ev.shiftKey ? -1 : 1);
          }
        }
      });

      // `+` button on the tab bar — same as Ctrl+Shift+T.
      document.getElementById('tabs-add')
        ?.addEventListener('click', () => this.cmdNewShell());
    }

    // Close Pane button is enabled whenever there's at least one tab.
    updateCommandButtons() {
      if (this.btnClosePane) this.btnClosePane.disabled = this.tabs.length === 0;
    }

    // ----- Command actions (shared by buttons + hotkeys) -----

    // Add a new tab. The first tab also reveals the extra pane and shows
    // the splitter; subsequent tabs are appended to the bar.
    cmdNewShell() {
      this.openTab({}).catch(() => { /* manager logs internally */ });
    }

    // Close the currently visible tab. We resolve "current" in two
    // steps to handle the case where the user has clicked inside a
    // tab's content (xterm canvas, browser view) — those clicks don't
    // bubble up to the tab strip, so the user perceives a different
    // tab as "active" than `activeTabId` reflects:
    //   1. If document.activeElement lives inside one of our tabs'
    //      hostEl, that's the tab we close (DOM focus wins).
    //   2. Otherwise fall back to `activeTabId` (the last-activated
    //      tab — what the visible tab-strip highlight shows).
    cmdClosePane() {
      if (this.tabs.length === 0) return;
      const focusEl = document.activeElement;
      let target = null;
      if (focusEl) {
        target = this.tabs.find((t) => t.hostEl && t.hostEl.contains(focusEl)) || null;
      }
      if (!target) {
        target = this.tabs.find((t) => t.paneId === this.activeTabId) || null;
      }
      if (target) this.closeTab(target.paneId);
    }


    wireFocus(el, name) {
      if (!el) return;
      el.addEventListener('mousedown', () => this.setFocus(name));
    }

    setFocus(name) {
      this.focused = name;
      this.main.el?.classList.toggle('pane--focused', name === 'main');
      this.extraSpec.el?.classList.toggle('pane--focused', name === 'extra');
      const target = name === 'main' ? this.main : this.activeTab();
      try { target?.term?.focus(); } catch { /* ignore */ }
    }

    activeTab() {
      return this.tabs.find((t) => t.paneId === this.activeTabId) || null;
    }

    refitAll() {
      // If the splitter is active, reapply its saved ratio first so the
      // flex-basis (which is in pixels) tracks the new container width
      // after a window resize.
      if (this.tabs.length > 0 && this.splitter) this.splitter.reapply();
      try { this.main.fit?.fit(); } catch { /* ignore */ }
      // Only the active tab needs to fit; the others are display:none and
      // their xterm canvases would measure to 0 anyway. They re-fit when
      // they become active.
      const active = this.activeTab();
      if (active?.kind === 'browser') {
        try { active.browserPane.refit(); } catch { /* ignore */ }
      } else {
        try { active?.fit?.fit(); } catch { /* ignore */ }
      }
    }

    // Open a new tab in the extra pane. First tab also reveals the pane
    // and shows the splitter (taking the splitter ratio from localStorage
    // or default 50/50). Subsequent tabs append to the bar.
    async openTab({ cwd } = {}) {
      const { el, tabsHost, makeTerminal } = this.extraSpec;
      const wasEmpty = this.tabs.length === 0;

      if (wasEmpty) {
        // Reveal the terminal area (hidden by default in the new
        // chat-first layout).
        document.getElementById('split-wrap')?.classList.remove('split-wrap--hidden');
        el.classList.remove('pane--hidden');
        this.wireFocus(el, 'extra');
        // One layout cycle so the pane has real dimensions before we
        // build xterm against it.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }

      const paneId = `tab-${++this.tabSeq}`;
      const label = labelFromCwd(cwd) || `Shell ${this.tabSeq}`;

      // Build per-tab DOM: a host div for the xterm + a tab button.
      const hostEl = document.createElement('div');
      hostEl.className = 'tab-host';
      hostEl.dataset.paneId = paneId;
      hostEl.dataset.kind = 'shell';
      // Clicks/focus inside the tab's content should also mark it
      // active, so Close-pane targets what the user is looking at.
      // mousedown beats click here — xterm captures click on its
      // canvas, but mousedown still bubbles.
      hostEl.addEventListener('mousedown', () => {
        if (this.activeTabId !== paneId) this.activateTab(paneId);
      });
      tabsHost.appendChild(hostEl);

      const tabEl = document.createElement('div');
      tabEl.className = 'tab';
      tabEl.dataset.paneId = paneId;
      tabEl.setAttribute('role', 'tab');
      const labelEl = document.createElement('span');
      labelEl.className = 'tab__label';
      labelEl.textContent = label;
      const closeEl = document.createElement('button');
      closeEl.className = 'tab__close';
      closeEl.type = 'button';
      closeEl.textContent = '×';
      closeEl.title = 'Close tab';
      closeEl.addEventListener('click', (ev) => {
        ev.stopPropagation();   // don't trigger tab activation
        this.closeTab(paneId);
      });
      tabEl.addEventListener('click', () => this.activateTab(paneId));
      tabEl.appendChild(labelEl);
      tabEl.appendChild(closeEl);
      document.getElementById('tabs-list')?.appendChild(tabEl);

      const { term, fit } = makeTerminal(hostEl);
      const tab = { kind: 'shell', paneId, term, fit, hostEl, tabEl, labelEl, label, cwd, shellPane: null };
      this.tabs.push(tab);

      // Activate the new tab so the user immediately sees it.
      this.activateTab(paneId);

      // Show the splitter on the first tab open. Must come AFTER the tab
      // is activated so the host has a stable size to fit against.
      if (wasEmpty) {
        this.splitter?.show();
      }
      this.updateCommandButtons();

      // Spin up the PTY-backed shell controller for this tab.
      tab.shellPane = new ShellPane({
        term,
        transport: this.transport,
        paneId,
        onClose: () => this.closeTab(paneId),
        manager: this,
      });
      try {
        await tab.shellPane.start({ cwd });
      } catch (err) {
        this.closeTab(paneId);
        throw err;
      }

      // After splitter + tab activation settle the layout, refit the
      // active tab's xterm so the canvas matches the visible host.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this.refitAll());
      });

      this.setFocus('extra');
    }

    // Open a browser tab in the extra pane. Same lifecycle as openTab —
    // first tab reveals the pane and splitter; subsequent tabs append
    // to the bar. Browser tabs use a BrowserView (out-of-DOM Chromium
    // widget); the .tab-host element just reserves a rectangle.
    async openBrowserTab({ url } = {}) {
      const { el, tabsHost } = this.extraSpec;
      const wasEmpty = this.tabs.length === 0;

      if (wasEmpty) {
        document.getElementById('split-wrap')?.classList.remove('split-wrap--hidden');
        el.classList.remove('pane--hidden');
        this.wireFocus(el, 'extra');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }

      const paneId = `tab-${++this.tabSeq}`;
      const initialURL = url || 'https://duckduckgo.com';
      const label = labelFromURL(initialURL) || `Browser ${this.tabSeq}`;

      const hostEl = document.createElement('div');
      hostEl.className = 'tab-host';
      hostEl.dataset.paneId = paneId;
      hostEl.dataset.kind = 'browser';
      hostEl.addEventListener('mousedown', () => {
        if (this.activeTabId !== paneId) this.activateTab(paneId);
      });
      tabsHost.appendChild(hostEl);

      const tabEl = document.createElement('div');
      tabEl.className = 'tab tab--browser';
      tabEl.dataset.paneId = paneId;
      tabEl.setAttribute('role', 'tab');
      const labelEl = document.createElement('span');
      labelEl.className = 'tab__label';
      labelEl.textContent = label;
      const closeEl = document.createElement('button');
      closeEl.className = 'tab__close';
      closeEl.type = 'button';
      closeEl.textContent = '×';
      closeEl.title = 'Close tab';
      closeEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeTab(paneId);
      });
      tabEl.addEventListener('click', () => this.activateTab(paneId));
      tabEl.appendChild(labelEl);
      tabEl.appendChild(closeEl);
      document.getElementById('tabs-list')?.appendChild(tabEl);

      const browserPane = new BrowserPane({
        transport: this.transport,
        tabId: paneId,
        hostEl,
        onTitle: (title) => {
          if (title) labelEl.textContent = title.slice(0, 40);
        },
      });

      const tab = {
        kind: 'browser', paneId, hostEl, tabEl, labelEl, label, browserPane,
      };
      this.tabs.push(tab);
      this.activateTab(paneId);

      if (wasEmpty) this.splitter?.show();
      this.updateCommandButtons();

      try {
        await browserPane.start({ initialURL });
      } catch (err) {
        this.closeTab(paneId);
        throw err;
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => this.refitAll());
      });
      this.setFocus('extra');
    }

    // Make `paneId` the visible tab. Hides others by removing their
    // active class. Refits the newly-active tab so xterm tracks the size.
    activateTab(paneId) {
      const tab = this.tabs.find((t) => t.paneId === paneId);
      if (!tab) return;
      // Hide whatever browser tab was active so its BrowserView
      // detaches before the new one shows. Skip if same tab.
      if (this.activeTabId && this.activeTabId !== paneId) {
        const prev = this.tabs.find((t) => t.paneId === this.activeTabId);
        if (prev?.kind === 'browser') prev.browserPane.hide();
      }
      this.activeTabId = paneId;
      for (const t of this.tabs) {
        const isActive = t.paneId === paneId;
        t.hostEl.classList.toggle('tab-host--active', isActive);
        t.tabEl.classList.toggle('tab--active', isActive);
      }
      requestAnimationFrame(() => {
        if (tab.kind === 'browser') {
          tab.browserPane.show();
        } else {
          try { tab.fit?.fit(); } catch { /* ignore */ }
          try { tab.term.focus(); } catch { /* ignore */ }
        }
      });
    }

    // Close one tab. If it was the active tab, the next tab in line
    // becomes active. Closing the last tab hides the extra pane and
    // splitter (matches the prior closeExtra behavior).
    closeTab(paneId) {
      const idx = this.tabs.findIndex((t) => t.paneId === paneId);
      if (idx < 0) return;
      const tab = this.tabs[idx];
      if (tab.kind === 'browser') {
        try { tab.browserPane.destroy(); } catch { /* ignore */ }
      } else {
        try { tab.shellPane?.cleanup(); } catch { /* ignore */ }
        try { tab.term.dispose(); } catch { /* ignore */ }
      }
      try { tab.hostEl.remove(); } catch { /* ignore */ }
      try { tab.tabEl.remove(); } catch { /* ignore */ }
      this.tabs.splice(idx, 1);

      if (this.tabs.length === 0) {
        // Last tab closed — hide the extra pane, splitter, AND the
        // whole terminal wrapper so the chat reclaims the window.
        this.activeTabId = null;
        this.extraSpec.el.classList.add('pane--hidden');
        this.splitter?.hide();
        document.getElementById('split-wrap')?.classList.add('split-wrap--hidden');
        this.updateCommandButtons();
        setTimeout(() => this.refitAll(), 0);
        this.setFocus('main');
        return;
      }

      // If we just closed the active tab, pick a sibling — prefer the
      // tab that took its slot, else the new last tab.
      if (this.activeTabId === paneId) {
        const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
        this.activateTab(next.paneId);
      }
      this.updateCommandButtons();
    }

    // Cycle through tabs by `direction` (+1 forward, -1 back). No-op
    // when fewer than 2 tabs exist.
    cycleTab(direction) {
      if (this.tabs.length < 2) return;
      const idx = this.tabs.findIndex((t) => t.paneId === this.activeTabId);
      if (idx < 0) return;
      const next = (idx + direction + this.tabs.length) % this.tabs.length;
      this.activateTab(this.tabs[next].paneId);
    }
  }

  // Pull a short tab label from a cwd path. Uses the basename; falls back
  // to null so the caller can supply a "Shell N" default.
  function labelFromCwd(cwd) {
    if (!cwd) return null;
    const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }

  // Pull a short tab label from a URL. Uses the hostname; falls back to
  // null so the caller can supply a "Browser N" default.
  function labelFromURL(url) {
    if (!url) return null;
    try { return new URL(url).hostname || null; } catch { return null; }
  }

  // ------------------------- SplitterDrag -----------------------------
  // Owns the draggable bar between main and extra panes. When hidden,
  // panes use their natural flex behavior (main pane fills width). When
  // shown, the splitter pins both panes to explicit pixel widths via
  // `flex-basis`, clamps to MIN_WIDTH, and persists the ratio in
  // localStorage so the next /shell new restores it.
  //
  // Refits during drag are throttled via requestAnimationFrame so we don't
  // re-tessellate xterm on every mousemove — one refit per frame is plenty
  // for the visual feedback and avoids pegging the CPU.

  const MIN_WIDTH = 80;            // px; matches CSS .pane min-width
  const STORAGE_KEY = 'myagent.splitter.mainWidth';

  class SplitterDrag {
    constructor({ element, mainPaneEl, extraPaneEl, onResize }) {
      this.el = element;
      this.mainPaneEl = mainPaneEl;
      this.extraPaneEl = extraPaneEl;
      this.onResize = onResize || (() => {});
      this.dragging = false;
      this.rafPending = false;

      // Pointer events handle mouse, pen, and touch uniformly, and let us
      // capture the pointer to the splitter so movement outside its bounds
      // (e.g. into a pane) still routes back here without losing focus.
      this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this._onMove = (e) => this.onPointerMove(e);
      this._onUp = (e) => this.onPointerUp(e);
    }

    show() {
      this.el.classList.remove('splitter--hidden');
      // Apply saved ratio (or default 50/50). Width is stored as a fraction
      // of the split container so the layout is stable across window
      // resizes.
      const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
      const split = this.containerWidth();
      const desired = Number.isFinite(saved) && saved > 0 && saved < 1
        ? Math.round(saved * split)
        : Math.round(split / 2);
      this.applyMainWidth(desired);
    }

    hide() {
      this.el.classList.add('splitter--hidden');
      // Clear pinned widths so the main pane returns to flex-fill behavior
      // when the extra pane is closed.
      this.mainPaneEl.style.flex = '';
      this.extraPaneEl.style.flex = '';
    }

    // Reapply the saved ratio against the *current* container width.
    // Called after a window resize so the pixel-pinned flex-basis tracks
    // the new available space. Skipped during an active drag — the user's
    // current pointer position is the source of truth, not the saved ratio.
    reapply() {
      if (this.dragging) return;
      if (this.el.classList.contains('splitter--hidden')) return;
      const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
      const split = this.containerWidth();
      const desired = Number.isFinite(saved) && saved > 0 && saved < 1
        ? Math.round(saved * split)
        : Math.round(split / 2);
      this.applyMainWidth(desired);
    }

    containerWidth() {
      const parent = this.el.parentElement;
      // Subtract the splitter's own width so the main+extra widths sum to
      // the available space.
      const splitterW = this.el.offsetWidth || 0;
      return parent.clientWidth - splitterW;
    }

    // Pin the main pane to `mainPx` and let the extra pane take the rest.
    // Clamped so neither pane drops below MIN_WIDTH.
    applyMainWidth(mainPx) {
      const total = this.containerWidth();
      const clamped = Math.max(MIN_WIDTH, Math.min(total - MIN_WIDTH, mainPx));
      this.mainPaneEl.style.flex = `0 0 ${clamped}px`;
      this.extraPaneEl.style.flex = `1 1 0`;
    }

    onPointerDown(e) {
      // Only react to primary button (or touch/pen primary contact).
      if (e.button !== 0 && e.button !== undefined) return;
      e.preventDefault();
      e.stopPropagation();   // don't let pane focus handlers see this
      this.dragging = true;
      this.el.classList.add('splitter--dragging');
      document.body.classList.add('is-resizing');
      // Capture so movement outside the splitter still routes here. This
      // is the key to drag-not-working bugs: without capture, moving into
      // an iframe or canvas (xterm's renderer) eats the events.
      try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const rect = this.el.parentElement.getBoundingClientRect();
      this.parentLeft = rect.left;
      // Listen on the splitter itself once captured — capture redirects
      // all subsequent pointer events for this pointerId here.
      this.el.addEventListener('pointermove', this._onMove);
      this.el.addEventListener('pointerup', this._onUp);
      this.el.addEventListener('pointercancel', this._onUp);
    }

    onPointerMove(e) {
      if (!this.dragging) return;
      const target = e.clientX - this.parentLeft;
      this.applyMainWidth(target);
      // rAF-throttle the refit. xterm's fit() is the expensive part; one
      // call per frame is plenty for visual smoothness.
      if (!this.rafPending) {
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.rafPending = false;
          if (this.dragging) this.onResize();
        });
      }
    }

    onPointerUp(e) {
      if (!this.dragging) return;
      this.el.classList.remove('splitter--dragging');
      document.body.classList.remove('is-resizing');
      try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.el.removeEventListener('pointermove', this._onMove);
      this.el.removeEventListener('pointerup', this._onUp);
      this.el.removeEventListener('pointercancel', this._onUp);

      // Persist the ratio FIRST, while widths still reflect where the user
      // released. If we did this after onResize(), refitAll() → reapply()
      // would already have read the stale ratio from storage and snapped
      // the panes back to their pre-drag width.
      const total = this.containerWidth();
      if (total > 0) {
        const mainPx = this.mainPaneEl.getBoundingClientRect().width;
        const ratio = mainPx / total;
        try { localStorage.setItem(STORAGE_KEY, String(ratio)); }
        catch { /* private mode etc. — drop */ }
      }

      // Now clear the dragging flag and refit. reapply() will read the
      // freshly-saved ratio (a no-op since widths already match it).
      this.dragging = false;
      this.onResize();
    }
  }

  window.MyAgent = window.MyAgent || {};
  window.MyAgent.TerminalShell = TerminalShell;
  window.MyAgent.ShellPane = ShellPane;
  window.MyAgent.BrowserPane = BrowserPane;
  window.MyAgent.PaneManager = PaneManager;
  window.MyAgent.SplitterDrag = SplitterDrag;
})();
