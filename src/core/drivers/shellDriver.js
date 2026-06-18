// Shell driver — runs commands in a persistent PTY and emits chat
// events per command. Same external contract as the model drivers, so the
// channel layer doesn't care which backend a worker uses.
//
// Command boundary detection: we append a sentinel echo after each
// command. After writing `<cmd>; echo __MYAGENT_SENTINEL_<n>_<exit>__`,
// we read PTY output until we see the sentinel string come back. The
// text up to (but not including) the sentinel is the command's output.
// `<n>` is a per-command counter so re-runs don't collide; `<exit>` is
// the previous command's exit (`$?` in bash, `$LASTEXITCODE` in PS).
//
// PowerShell-aware: PowerShell uses `;` to separate, `$LASTEXITCODE`
// for the exit code, and Write-Output instead of echo. We detect the
// shell from the binary path and pick the right sentinel template.
//
// Persistent state: the PTY lives until close(). `cd`, env vars,
// shell history all carry across commands.

const pty = require('@lydell/node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SENTINEL_PREFIX = '__MYAGENT_SENTINEL_';

// Fixed, well-known absolute shell paths — constants only, so no env value
// flows into the existsSync sink (avoids the js/path-injection taint and is
// safer). Windows installs under C:\Windows, so these are stable.
const WINDOWS_SHELL_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];
function detectShell() {
  if (process.platform === 'win32') {
    for (const c of WINDOWS_SHELL_CANDIDATES) {
      try { if (fs.existsSync(c)) return { bin: c, kind: 'powershell' }; } catch { /* ignore */ }
    }
    return { bin: process.env.COMSPEC || 'cmd.exe', kind: 'cmd' };
  }
  return { bin: process.env.SHELL || '/bin/bash', kind: 'bash' };
}

// Strip ANSI sequences (colors, cursor moves) from a chunk of PTY output.
// Shell output usually has limited ANSI — prompt colors mainly — so a
// straightforward CSI/OSC stripper works without xterm-grade emulation.
function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC ... BEL
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')     // OSC ... ST
    .replace(/\x1b[NOP@-Z\\\^_]/g, '')        // C1 escapes
    .replace(/\r(?!\n)/g, '');                // bare CR (in-place redraws)
}

class ShellDriver {
  constructor({ agentId, cwd, onEvent } = {}) {
    this.agentId = agentId;
    this.cwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    this.onEvent = onEvent || (() => {});
    this.shell = detectShell();
    this.term = null;
    this.closed = false;
    this.commandCounter = 0;
    // Active turn state.
    this.turnActive = false;
    this.pendingUserText = null;
    this.outputBuffer = '';      // raw output accumulated during this turn
    this.activeSentinel = null;  // string we're scanning for to mark end
  }

  async start() {
    if (this.term) return;
    // Wide cols so our sentinel-bearing input line doesn't wrap. Most
    // shells reflow the visible echo of input when it exceeds width,
    // and that breaks our line-based filtering. 400 fits even verbose
    // PowerShell input.
    this.term = pty.spawn(this.shell.bin, [], {
      name: 'xterm-256color',
      cols: 400,
      rows: 30,
      cwd: this.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    this.term.onData((data) => this._onData(data));
    this.term.onExit(({ exitCode, signal }) => {
      this.closed = true;
      this.term = null;
      if (this.turnActive) {
        this._finalizeTurn(this.outputBuffer, null, true);
      }
      this.onEvent('chat:driver-exit', { agentId: this.agentId, code: exitCode, signal });
    });

    // Run a primer command synchronously to swallow the shell's
    // startup banner. We turn turnActive on, send a no-op command
    // that produces a sentinel, wait for it, and discard.
    this._primerDone = new Promise((resolve) => { this._primerResolve = resolve; });
    this.turnActive = true;
    this.pendingUserText = '__primer__';
    this.commandCounter += 1;
    this.activeSentinel = `${SENTINEL_PREFIX}${this.commandCounter}_DONE_`;
    let primerLine;
    if (this.shell.kind === 'powershell') {
      primerLine = `Write-Output "${this.activeSentinel}0"`;
    } else if (this.shell.kind === 'cmd') {
      primerLine = `echo ${this.activeSentinel}0`;
    } else {
      primerLine = `echo "${this.activeSentinel}0"`;
    }
    this.term.write(primerLine + '\r');
    await Promise.race([
      this._primerDone,
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    // Drain any post-primer bytes (PowerShell's prompt redraw, late
    // banner flushes) before declaring the driver ready.
    await new Promise((r) => setTimeout(r, 250));
    this.turnActive = false;
    this.pendingUserText = null;
    this.outputBuffer = '';
    this.activeSentinel = null;
    this._primerDone = null;
  }

  send(text) {
    if (this.closed || !this.term) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'shell not running' });
      return;
    }
    if (this.turnActive) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'previous command still in progress' });
      return;
    }
    const cmd = text.trim();
    if (!cmd) return;
    this.turnActive = true;
    this.pendingUserText = text;
    this.outputBuffer = '';
    this.commandCounter += 1;
    this.activeSentinel = `${SENTINEL_PREFIX}${this.commandCounter}_DONE_`;

    this.onEvent('chat:user', { agentId: this.agentId, text });
    this.onEvent('chat:turn-start', { agentId: this.agentId });

    // Compose: <user-cmd> <separator> echo <SENTINEL><exit-code>
    // We coalesce undefined/null exit codes to 0 so the sentinel
    // always has a numeric suffix, which makes detection unambiguous.
    let line;
    if (this.shell.kind === 'powershell') {
      // PowerShell: $LASTEXITCODE is set only after native commands
      // and may be $null on the first invocation. Coalesce.
      line = `${cmd}; if ($LASTEXITCODE -eq $null) { $__ec = 0 } else { $__ec = $LASTEXITCODE }; Write-Output "${this.activeSentinel}$__ec"`;
    } else if (this.shell.kind === 'cmd') {
      line = `${cmd} & echo ${this.activeSentinel}%errorlevel%`;
    } else {
      line = `${cmd}; echo "${this.activeSentinel}$?"`;
    }
    this.term.write(line + '\r');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.term) return;
    try { this.term.kill(); } catch { /* ignore */ }
    this.term = null;
  }

  // --- internal -----------------------------------------------------------

  _onData(data) {
    if (!this.turnActive) {
      return;
    }
    this.outputBuffer += data;
    if (process.env.MYAGENT_SHELL_DEBUG) {
      process.stderr.write(`[shell:${this.agentId}] recv ${JSON.stringify(data)}\n`);
    }
    // Look for the sentinel. It shows up in two places: the echoed
    // command line (because PowerShell echoes our composed input) and
    // the actual echo output. The actual output is identifiable by
    // having only the sentinel + a number, no surrounding command.
    // We scan stripped output to make pattern matching easier.
    const stripped = stripAnsi(this.outputBuffer);
    // Find ALL sentinel occurrences. The first is usually the input
    // echo (PowerShell prints what we typed), the second is the
    // actual output of our Write-Output. We pick the LAST occurrence
    // followed by a digit-only exit code, which is unambiguous since
    // the input echo carries the variable name (e.g. `$__ec`).
    const sentinelRe = new RegExp(`${this.activeSentinel}(\\d+)`, 'g');
    const matches = [...stripped.matchAll(sentinelRe)];
    if (matches.length === 0) return;
    const last = matches[matches.length - 1];
    const exitCode = parseInt(last[1], 10);

    // Output is everything before the LAST sentinel match. Then strip
    // the leading line which was the shell's echo of our input.
    let body = stripped.slice(0, last.index);
    // Drop any line containing OUR sentinel prefix — covers the input
    // echo and any leftover primer residue from previous commands.
    body = body
      .split('\n')
      .filter((ln) => !ln.includes(SENTINEL_PREFIX))
      .join('\n');
    body = body.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');

    this._finalizeTurn(body, exitCode, false);
  }

  _finalizeTurn(body, exitCode, crashed) {
    if (!this.turnActive) return;
    // Primer turn: clear buffers + signal start(), emit nothing.
    if (this.pendingUserText === '__primer__') {
      this.turnActive = false;
      this.pendingUserText = null;
      this.outputBuffer = '';
      this.activeSentinel = null;
      if (this._primerResolve) this._primerResolve();
      return;
    }
    this.turnActive = false;
    const userText = this.pendingUserText;
    this.pendingUserText = null;
    this.outputBuffer = '';
    this.activeSentinel = null;

    if (body && body.trim()) {
      this.onEvent('chat:chunk', {
        agentId: this.agentId,
        kind: 'shell-output',
        text: body,
      });
    }
    this.onEvent('chat:turn-end', {
      agentId: this.agentId,
      userText,
      assistantText: body || '',
      ok: !crashed && (exitCode == null || exitCode === 0),
      totals: { exitCode },
      result: body || '',
    });
  }
}

module.exports = { ShellDriver };
