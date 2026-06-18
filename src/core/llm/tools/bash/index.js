// bash — run a one-shot shell command. Each call is independent; no state
// carries between calls (no `cd` persistence, no shared env mutations).
// Use this for build/test/git/lint commands and quick filesystem ops the
// other tools don't cover.
//
// Args:
//   { command: string, cwd?: string, timeout_ms?: number, max_output_bytes?: number }
//
// Behavior:
//   - `cwd` defaults to ctx.cwd. The resolved cwd must be inside ctx.scope,
//     otherwise the call is refused. The command itself is NOT sandboxed —
//     it runs with the user's full permissions. cwd-in-scope is a soft
//     fence, not a security boundary.
//   - Shell auto-detected: pwsh > powershell.exe on win32, $SHELL or
//     /bin/bash elsewhere. We invoke with `-Command` (PowerShell) or
//     `-lc` (bash) so the command string can use shell features (pipes,
//     redirection, env vars).
//   - Hard timeout (default 120s). On timeout we kill the process tree
//     and return what was captured so far with a timeout marker.
//   - stdout and stderr are captured separately and each truncated to
//     max_output_bytes (default 64 KB) so a chatty command can't blow
//     up the model's context.
//
// Returns:
//   { ok, content, data: { command, cwd, exitCode, signal, durationMs,
//                          stdout, stderr, stdoutTruncated, stderrTruncated,
//                          timedOut } }
//   `ok` is true iff the process exited with code 0 and did not time out.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const processes = require('./processes');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function detectShell() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
      process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : null,
    ].filter(Boolean);
    // Constant allowlist of shell basenames — bounds discovery to real shells
    // and is the constant-comparison barrier for the existsSync below (a
    // candidate partly derives from SystemRoot).
    const ALLOWED_SHELLS = new Set(['pwsh.exe', 'powershell.exe', 'cmd.exe']);
    for (const c of candidates) {
      if (!path.isAbsolute(c) || !ALLOWED_SHELLS.has(path.basename(c).toLowerCase())) continue;
      try { if (fs.existsSync(c)) return { bin: c, kind: 'powershell' }; } catch { /* ignore */ }
    }
    return { bin: process.env.COMSPEC || 'cmd.exe', kind: 'cmd' };
  }
  return { bin: process.env.SHELL || '/bin/bash', kind: 'bash' };
}

function shellArgs(shell, command) {
  if (shell.kind === 'powershell') {
    // -NoProfile keeps startup fast and deterministic. -NonInteractive
    // makes prompts fail fast instead of hanging.
    return ['-NoProfile', '-NonInteractive', '-Command', command];
  }
  if (shell.kind === 'cmd') {
    return ['/d', '/s', '/c', command];
  }
  return ['-lc', command];
}

module.exports = {
  name: 'bash',
  description:
    'Run a shell command. Foreground by default: blocks until exit and ' +
    'returns stdout/stderr/exit code. Set run_in_background=true for ' +
    'long-running processes (dev servers, watchers, daemons): the call ' +
    'returns immediately with a pid you can later poll via bash_output ' +
    'or terminate via bash_kill. Each call is independent (no cd ' +
    'persistence). cwd must be inside an allowed scope. Avoid interactive ' +
    'commands in foreground mode — they will hang and time out.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to run. Passed to the system shell via -Command (PowerShell) or -lc (bash).',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Absolute, or relative to the worker cwd. Must be inside an allowed scope. Defaults to the worker cwd.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1,
        description: `Hard timeout in ms (foreground only). Default ${DEFAULT_TIMEOUT_MS}.`,
      },
      max_output_bytes: {
        type: 'integer',
        minimum: 1,
        description: `Truncate each of stdout/stderr to this many bytes (foreground only). Default ${DEFAULT_MAX_OUTPUT_BYTES}.`,
      },
      run_in_background: {
        type: 'boolean',
        description: 'Spawn the process and return immediately with its pid. Use for dev servers, watchers, or anything that does not exit on its own. Poll with bash_output, stop with bash_kill.',
      },
    },
    required: ['command'],
  },
  async run(args, ctx = {}) {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) {
      return { ok: false, content: 'bash: missing required argument "command"' };
    }

    const workerCwd = ctx.cwd || process.cwd();
    const rawCwd = args.cwd ? String(args.cwd) : workerCwd;
    const cwd = path.isAbsolute(rawCwd) ? rawCwd : path.resolve(workerCwd, rawCwd);

    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'bash: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(cwd)) {
      return { ok: false, content: `bash: cwd '${cwd}' is outside allowed scopes. Add the directory in Settings → Scopes to allow.` };
    }
    let stat;
    try { stat = fs.statSync(cwd); }
    catch (err) { return { ok: false, content: `bash: cwd not accessible: ${err.message}` }; }
    if (!stat.isDirectory()) {
      return { ok: false, content: `bash: cwd '${cwd}' is not a directory` };
    }

    const timeoutMs = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
      ? Math.floor(args.timeout_ms)
      : DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = Number.isFinite(args.max_output_bytes) && args.max_output_bytes > 0
      ? Math.floor(args.max_output_bytes)
      : DEFAULT_MAX_OUTPUT_BYTES;

    // SECURITY (js/command-line-injection): running an arbitrary shell command
    // IS this tool's purpose, so the boundary is not "avoid the spawn" — it is
    // the gate above:
    //   1. ctx.scope.containsSync(cwd) — refuses to run outside an allowed scope
    //      (no scope on context => hard refusal at line ~115).
    //   2. the preTool hook phase (e.g. no-secrets) runs BEFORE this tool is
    //      dispatched and can block the call (see src/hooks, hooks_two_phase).
    // Both spawn sites below are reached only after those checks pass. The
    // command is handed to the shell intentionally; do not "sanitize" it.
    const shell = detectShell();
    const spawnArgs = shellArgs(shell, command);

    if (args.run_in_background === true) {
      let child;
      try {
        child = spawn(shell.bin, spawnArgs, {
          cwd,
          env: { ...process.env },
          windowsHide: true,
          detached: false,
        });
      } catch (err) {
        return { ok: false, content: `bash: spawn failed: ${err.message}` };
      }
      const pid = processes.register(child, { command, cwd });
      return {
        ok: true,
        content: `bash: started in background (pid=${pid}, cwd=${cwd})\n$ ${command}\nPoll output with bash_output { pid: ${pid} } or stop with bash_kill { pid: ${pid} }.`,
        data: {
          pid,
          command,
          cwd,
          background: true,
        },
      };
    }

    return await new Promise((resolve) => {
      const started = Date.now();
      let child;
      try {
        child = spawn(shell.bin, spawnArgs, {
          cwd,
          env: { ...process.env },
          windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, content: `bash: spawn failed: ${err.message}` });
        return;
      }

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutTruncated = false;
      let stderrTruncated = false;

      child.stdout.on('data', (chunk) => {
        if (stdoutBytes >= maxOutputBytes) { stdoutTruncated = true; return; }
        const room = maxOutputBytes - stdoutBytes;
        if (chunk.length <= room) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdoutChunks.push(chunk.slice(0, room));
          stdoutBytes = maxOutputBytes;
          stdoutTruncated = true;
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderrBytes >= maxOutputBytes) { stderrTruncated = true; return; }
        const room = maxOutputBytes - stderrBytes;
        if (chunk.length <= room) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        } else {
          stderrChunks.push(chunk.slice(0, room));
          stderrBytes = maxOutputBytes;
          stderrTruncated = true;
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeoutMs);

      const onAbort = () => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      };
      const signal = ctx.signal || ctx.abortSignal;
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, content: `bash: process error: ${err.message}` });
      });

      child.on('close', (code, sigName) => {
        clearTimeout(timer);
        const durationMs = Date.now() - started;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        const exitCode = typeof code === 'number' ? code : null;
        const ok = !timedOut && exitCode === 0;

        const lines = [];
        lines.push(`$ ${command}`);
        lines.push(`(cwd=${cwd}, exit=${exitCode == null ? '?' : exitCode}${sigName ? `, signal=${sigName}` : ''}${timedOut ? ', TIMED OUT' : ''}, ${durationMs}ms)`);
        if (stdout) {
          lines.push('--- stdout ---');
          lines.push(stdout.replace(/\s+$/, ''));
          if (stdoutTruncated) lines.push(`[stdout truncated at ${maxOutputBytes} bytes]`);
        }
        if (stderr) {
          lines.push('--- stderr ---');
          lines.push(stderr.replace(/\s+$/, ''));
          if (stderrTruncated) lines.push(`[stderr truncated at ${maxOutputBytes} bytes]`);
        }
        if (!stdout && !stderr) lines.push('(no output)');

        resolve({
          ok,
          content: lines.join('\n'),
          data: {
            command,
            cwd,
            exitCode,
            signal: sigName || null,
            durationMs,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            timedOut,
          },
        });
      });
    });
  },
};

// Surface internal helpers for tests.
module.exports._detectShell = detectShell;
module.exports._shellArgs = shellArgs;
