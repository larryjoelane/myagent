// Driver for Claude Code's headless mode. Spawns one long-running
// `claude -p --input-format stream-json --output-format stream-json`
// per worker. Each user message goes in as a JSON line on stdin; the
// process emits structured JSON events on stdout, one per line.
//
// Event vocabulary observed during probing (claude 2.1.122):
//   system/init       — session metadata, fires at the start of every turn
//   system/status     — runtime status, ignored
//   rate_limit_event  — informational, ignored
//   stream_event      — wraps streaming deltas (used only with --include-partial-messages)
//   assistant         — full assistant message after streaming completes; content is array of blocks
//   user              — user-side messages; tool_result blocks come back this way
//   result/success    — turn done, has totals (cost, tokens, permission_denials)
//
// We emit chat:* events the channel can forward unchanged. The driver
// keeps no UI state — it just translates.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

// Resolve a bare command name to an absolute path by walking PATH, honoring
// PATHEXT on Windows (.cmd/.bat shims). Returns the name unchanged if no match
// is found, letting spawn() surface a clean ENOENT. We resolve explicitly so we
// can spawn with shell:false — passing a bare name to a shell (shell:true) would
// re-parse argv through cmd/sh and is the command-injection surface CodeQL flags.
function resolveOnPath(name) {
  if (path.isAbsolute(name)) return name;
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.toLowerCase())
    : [''];
  const dirs = (process.env.PATH || process.env.Path || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* keep scanning */ }
    }
  }
  return name;
}

class ClaudeDriver {
  constructor({ agentId, cwd, permissionMode, onEvent, spawnFn } = {}) {
    this.agentId = agentId;
    this.cwd = cwd || process.cwd();
    this.permissionMode = permissionMode || DEFAULT_PERMISSION_MODE;
    this.onEvent = onEvent || (() => {});
    // Injectable subprocess factory — defaults to real spawn(). Tests
    // pass a fake that returns an EventEmitter-like object with
    // stdout/stderr streams and a writable stdin.
    //
    // Test hooks:
    //   MYAGENT_TEST_CLAUDE_BIN  — substitute the binary (e.g. `node`)
    //   MYAGENT_TEST_CLAUDE_ARGS — prepended to argv (e.g. fake-claude.js path)
    // Both undefined = real claude.
    // Resolve the binary to an absolute path up front so we can spawn with
    // shell:false (no shell re-parsing of argv => no command-line injection).
    // In the test path MYAGENT_TEST_CLAUDE_BIN is typically `node`, which
    // resolveOnPath finds on PATH; the fake-claude script comes in via prefixArgs.
    const bin = resolveOnPath(process.env.MYAGENT_TEST_CLAUDE_BIN || 'claude');
    const prefixArgs = process.env.MYAGENT_TEST_CLAUDE_ARGS
      ? process.env.MYAGENT_TEST_CLAUDE_ARGS.split('|').filter(Boolean)
      : [];
    this.spawnFn = spawnFn || ((args, opts) => spawn(bin, [...prefixArgs, ...args], { ...opts, shell: false }));
    this.proc = null;
    this.buffer = '';
    this.closed = false;
    this.turnActive = false;
    this.assistantText = '';      // accumulated text-only response for memory mirror
    this.pendingUserText = null;
    this.sessionId = null;
    this.lastError = null;
  }

  // Start the subprocess. Resolves once spawn succeeds. The first
  // `system/init` event fires AFTER the first user message in
  // stream-json input mode, so we don't wait for it here.
  async start() {
    if (this.proc) return;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.permissionMode,
    ];
    this.proc = this.spawnFn(args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (process.env.MYAGENT_DRIVER_DEBUG) {
        process.stderr.write(`[claude:${this.agentId}] stderr: ${text}`);
      }
    });
    this.proc.on('exit', (code, signal) => this._onExit(code, signal));
    this.proc.on('error', (err) => {
      this.lastError = err;
      this.onEvent('chat:error', { agentId: this.agentId, error: `claude failed to spawn: ${err.message}` });
    });

    // Resolve as soon as the process is spawned. Spawn errors will
    // surface via the 'error' event and chat:error.
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(), 200); // give it a tick to error if it's going to
      this.proc.once('error', (err) => { clearTimeout(t); reject(err); });
    });
  }

  // Send a user prompt. Wraps it in the stream-json input format.
  send(text) {
    if (this.closed || !this.proc) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'driver not running' });
      return;
    }
    if (this.turnActive) {
      // Don't queue; reject. Caller can retry once turn-end fires.
      this.onEvent('chat:error', { agentId: this.agentId, error: 'previous turn still in progress' });
      return;
    }
    this.turnActive = true;
    this.assistantText = '';
    this.pendingUserText = text;
    this.onEvent('chat:user', { agentId: this.agentId, text });
    this.onEvent('chat:turn-start', { agentId: this.agentId });

    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      this.turnActive = false;
      this.onEvent('chat:error', { agentId: this.agentId, error: `stdin write failed: ${err.message}` });
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    // Give claude a moment to exit cleanly; force kill if it doesn't.
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve();
      }, 2000);
      this.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    this.proc = null;
  }

  // --- internal -----------------------------------------------------------

  _onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch (err) {
        // Defensive — claude shouldn't emit non-JSON, but if it does,
        // log and skip rather than crash the driver.
        if (process.env.MYAGENT_DRIVER_DEBUG) {
          process.stderr.write(`[claude:${this.agentId}] non-JSON line: ${line.slice(0, 200)}\n`);
        }
        continue;
      }
      this._handleEvent(event);
    }
  }

  _handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'system' && event.subtype === 'init') {
      // Fires once at startup AND at the start of every turn. We use
      // the first one to satisfy the start() promise; later ones are
      // ignored.
      if (!this.sessionId) {
        this.sessionId = event.session_id;
        this._emit('init');
      }
      return;
    }

    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      // Render each content block. Text → chat:chunk with kind 'text'.
      // tool_use → chat:chunk with kind 'tool-use', payload includes
      // the structured tool name + input.
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          this.assistantText += (this.assistantText ? '\n' : '') + block.text;
          this.onEvent('chat:chunk', {
            agentId: this.agentId,
            kind: 'text',
            text: block.text,
          });
        } else if (block.type === 'tool_use') {
          this.onEvent('chat:chunk', {
            agentId: this.agentId,
            kind: 'tool-use',
            toolUseId: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'thinking' && block.thinking) {
          this.onEvent('chat:chunk', {
            agentId: this.agentId,
            kind: 'thinking',
            text: block.thinking,
          });
        }
      }
      return;
    }

    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      // Tool results come back as user messages with tool_result content.
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          this.onEvent('chat:chunk', {
            agentId: this.agentId,
            kind: 'tool-result',
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: !!block.is_error,
          });
        }
      }
      return;
    }

    if (event.type === 'result') {
      // Turn finished. Emit chat:turn-end with totals + memory text.
      const ok = event.is_error === false || event.subtype === 'success';
      this.onEvent('chat:turn-end', {
        agentId: this.agentId,
        userText: this.pendingUserText,
        assistantText: this.assistantText,
        ok,
        totals: {
          durationMs: event.duration_ms,
          numTurns: event.num_turns,
          costUsd: event.total_cost_usd,
          permissionDenials: event.permission_denials || [],
          stopReason: event.stop_reason,
        },
        result: event.result,
      });
      this.turnActive = false;
      this.pendingUserText = null;
      this.assistantText = '';
      return;
    }

    // Other event types (system/status, rate_limit_event, stream_event)
    // are ignored — they're informational or only relevant when we
    // turn on partial-message streaming later.
    if (process.env.MYAGENT_DRIVER_DEBUG) {
      process.stderr.write(`[claude:${this.agentId}] ignored event: ${event.type}/${event.subtype || ''}\n`);
    }
  }

  _onExit(code, signal) {
    this.closed = true;
    this.proc = null;
    if (this.turnActive) {
      // Crashed mid-turn — finalize so the UI doesn't hang.
      this.onEvent('chat:turn-end', {
        agentId: this.agentId,
        userText: this.pendingUserText,
        assistantText: this.assistantText,
        ok: false,
        result: `claude exited with code ${code}${signal ? ' signal ' + signal : ''}`,
      });
      this.turnActive = false;
    }
    this.onEvent('chat:driver-exit', { agentId: this.agentId, code, signal });
  }

  // Tiny one-shot event subscriber for our own internal init signal.
  // Not exposed externally.
  _once(name, fn) {
    this._listeners = this._listeners || {};
    (this._listeners[name] = this._listeners[name] || []).push(fn);
    return () => {
      const arr = this._listeners[name];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    };
  }
  _emit(name) {
    const arr = this._listeners && this._listeners[name];
    if (!arr) return;
    for (const fn of arr.slice()) fn();
    arr.length = 0;
  }
}

module.exports = { ClaudeDriver };
