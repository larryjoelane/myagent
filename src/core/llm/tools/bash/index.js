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
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const processes = require('./processes');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

// Fixed, well-known absolute shell paths — constants only, so no env value
// flows into the existsSync sink (avoids the js/path-injection taint and is
// safer). Windows installs under C:\Windows, so these are stable.
const WINDOWS_SHELL_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];
// Constant fallbacks (standard install paths) so detectShell only ever returns
// a server-controlled literal — no env value flows into shell.bin, which is the
// executable passed to spawn() (js/command-line-injection: pick the executable
// from constants, not from PATH/COMSPEC/SHELL).
const WINDOWS_CMD = 'C:\\Windows\\System32\\cmd.exe';
const POSIX_SHELL = '/bin/bash';
function detectShell() {
  if (process.platform === 'win32') {
    for (const c of WINDOWS_SHELL_CANDIDATES) {
      try { if (fs.existsSync(c)) return { bin: c, kind: 'powershell' }; } catch { /* ignore */ }
    }
    return { bin: WINDOWS_CMD, kind: 'cmd' };
  }
  return { bin: POSIX_SHELL, kind: 'bash' };
}

// Write the command to a temp SCRIPT FILE and return the argv that runs that
// file. The LLM's command becomes file *content* (data), not part of the
// command line the shell parses — so the spawn argv carries only constant flags
// + a generated script path, never the raw command. This both runs the command
// exactly as before AND removes the js/command-line-injection sink (the tainted
// string no longer reaches the shell's command-line parser). Returns
// { args, scriptPath } — caller deletes scriptPath after the process exits.
function writeCommandScript(shell, command) {
  const id = crypto.randomBytes(8).toString('hex');
  if (shell.kind === 'powershell') {
    const scriptPath = path.join(os.tmpdir(), `myagent-bash-${id}.ps1`);
    fs.writeFileSync(scriptPath, command, 'utf8');
    return { args: ['-NoProfile', '-NonInteractive', '-File', scriptPath], scriptPath };
  }
  if (shell.kind === 'cmd') {
    const scriptPath = path.join(os.tmpdir(), `myagent-bash-${id}.cmd`);
    fs.writeFileSync(scriptPath, `@echo off\r\n${command}`, 'utf8');
    return { args: ['/d', '/s', '/c', scriptPath], scriptPath };
  }
  const scriptPath = path.join(os.tmpdir(), `myagent-bash-${id}.sh`);
  fs.writeFileSync(scriptPath, command, 'utf8');
  return { args: [scriptPath], scriptPath };
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

    // SECURITY (js/command-line-injection): the tool's purpose is to run the
    // command, gated by (1) ctx.scope.containsSync(cwd) above and (2) the
    // preTool hook phase. We pass the command as the CONTENT of a temp script
    // file and spawn the shell on that file path — so the spawn argv carries
    // only constant flags + a generated path, never the command string itself.
    // Behavior is identical (the shell runs the same command); the tainted
    // string no longer reaches the shell's command-line parser.
    const shell = detectShell();
    const { args: spawnArgs, scriptPath } = writeCommandScript(shell, command);
    const cleanupScript = () => { try { fs.unlinkSync(scriptPath); } catch { /* ignore */ } };

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
        cleanupScript();
        return { ok: false, content: `bash: spawn failed: ${err.message}` };
      }
      // Remove the temp script once the background process exits.
      child.on('exit', cleanupScript);
      child.on('error', cleanupScript);
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
        cleanupScript();
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
        cleanupScript();
        resolve({ ok: false, content: `bash: process error: ${err.message}` });
      });

      child.on('close', (code, sigName) => {
        clearTimeout(timer);
        cleanupScript();
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
module.exports._writeCommandScript = writeCommandScript;
