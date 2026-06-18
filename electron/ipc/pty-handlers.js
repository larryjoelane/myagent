// IPC handlers for the PTY surface. Each pane in the renderer can host
// its own PTY, so the same window may have several at once (one per
// pane). The registry is keyed by `${webContentsId}:${paneId}` —
// pty:start replaces any existing PTY for that key, so re-running
// /shell in the same pane is safe.
//
// State (the ptys Map) is module-private. main.js drives lifecycle via
// the helpers we export: killForWebContents (called from
// webContents.destroyed) and killAll (called from before-quit, before
// the session log closes).
//
// Wired in from electron/main.js via register(deps).

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');

const ptys = new Map();
const ptyKey = (contentsId, paneId) => `${contentsId}:${paneId || 'main'}`;

// Picks a sensible interactive shell on Windows. We probe a FIXED list of
// well-known absolute install paths (constants — no env value flows into the fs
// sink, which is both safer and avoids the js/path-injection taint from
// COMSPEC/SystemRoot). Windows always installs under C:\Windows, so the
// system32 paths are stable across machines.
const WINDOWS_SHELL_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Windows\\System32\\cmd.exe',
];
function defaultWindowsShell() {
  for (const c of WINDOWS_SHELL_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'powershell.exe';
}

function defaultShell() {
  // Test hook: MYAGENT_TEST_SHELL lets e2e tests run a deterministic
  // program (like fake-claude) directly as the PTY's "shell" — no
  // PowerShell in the way. Used only by tests/e2e/.
  if (process.env.MYAGENT_TEST_SHELL) return process.env.MYAGENT_TEST_SHELL;
  if (process.platform === 'win32') return defaultWindowsShell();
  return process.env.SHELL || '/bin/bash';
}

function defaultShellArgs() {
  if (process.env.MYAGENT_TEST_SHELL_ARGS) {
    return process.env.MYAGENT_TEST_SHELL_ARGS.split('|').filter(Boolean);
  }
  return [];
}

/**
 * @typedef {object} PtyHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('../../src/core/sessionLog').SessionLog} sessionLog
 * @property {ReturnType<typeof import('../../src/core/agentRegistry').createAgentRegistry>} agentRegistry
 * @property {string} sessionsDir
 * @property {string} memoriesDir
 * @property {(cwd: string) => any} snapshotBefore
 * @property {(snapshot: any, cwd: string) => any[]} summarizeWindow
 * @property {(opts: { outRoot: string, sessionsByProject: object }) => unknown} mirrorAll
 * @property {(summaries: any[]) => object} groupSessionsByProject
 */

/** @param {PtyHandlerDeps} deps */
function register({
  ipcMain, sessionLog, agentRegistry, sessionsDir, memoriesDir,
  snapshotBefore, summarizeWindow, mirrorAll, groupSessionsByProject,
}) {
  ipcMain.handle('pty:start', (event, { paneId, cwd, cols, rows } = {}) => {
    const pane = paneId || 'main';
    const key = ptyKey(event.sender.id, paneId);
    // Replace any existing PTY for this key (e.g., user typed /shell twice
    // in the same pane).
    const existing = ptys.get(key);
    if (existing) {
      try { existing.kill(); } catch { /* ignore */ }
      ptys.delete(key);
    }

    const shell = defaultShell();
    const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const term = pty.spawn(shell, defaultShellArgs(), {
      name: 'xterm-256color',
      cols: cols || 100,
      rows: rows || 30,
      cwd: resolvedCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        // Lets tooling find the session discovery file without re-deriving
        // PROJECT_ROOT every invocation.
        MYAGENT_SESSIONS_DIR: sessionsDir,
      },
    });

    const rawLog = sessionLog.openRaw(pane);
    // Snapshot all of ~/.claude/projects/ so we can detect any `claude`
    // invocations that ran inside this PTY (regardless of which project dir
    // the user `cd`d into) and pull their model/token data.
    const claudeSnapshot = snapshotBefore(resolvedCwd);
    // On Windows ConPTY, term.pid is 0 immediately after spawn — the child
    // hasn't been created yet. Defer the pty-start log entry one tick so we
    // have a real pid to record.
    setImmediate(() => {
      sessionLog.append('pty-start', { shell, pid: term.pid, cwd: resolvedCwd, rawLog }, pane);
    });

    term.onData((data) => {
      sessionLog.rawOut(pane, data);
      sessionLog.ptyOut(pane, data);
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty:data', { paneId: pane, data });
      }
    });
    term.onExit(({ exitCode, signal }) => {
      sessionLog.append('pty-exit', { exitCode, signal }, pane);
      sessionLog.closeRaw(pane);
      agentRegistry.dropWhere((a) => a.paneId === pane && a.webContentsId === event.sender.id);
      try {
        const summaries = summarizeWindow(claudeSnapshot, resolvedCwd);
        for (const s of summaries) {
          sessionLog.append('pty-agent-summary', s, pane);
        }
        if (summaries.length > 0) {
          // Refresh the markdown mirror for any project that had a `claude`
          // session in this window. Keeps Obsidian view current without
          // waiting for app shutdown.
          const grouped = groupSessionsByProject(summaries);
          mirrorAll({ outRoot: memoriesDir, sessionsByProject: grouped });
        }
      } catch { /* ignore: log correlation must not crash the app */ }
      ptys.delete(key);
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty:exit', { paneId: pane, exitCode, signal });
      }
    });

    ptys.set(key, term);
    return { ok: true, shell, pid: term.pid };
  });

  ipcMain.on('pty:input', (event, { paneId, data } = {}) => {
    const term = ptys.get(ptyKey(event.sender.id, paneId));
    if (term && typeof data === 'string') {
      sessionLog.ptyIn(paneId || 'main', data);
      term.write(data);
    }
  });

  ipcMain.on('pty:resize', (event, { paneId, cols, rows } = {}) => {
    const term = ptys.get(ptyKey(event.sender.id, paneId));
    if (term && cols > 0 && rows > 0) {
      try { term.resize(cols, rows); } catch { /* ignore */ }
    }
  });

  ipcMain.on('pty:kill', (event, { paneId } = {}) => {
    const key = ptyKey(event.sender.id, paneId);
    const term = ptys.get(key);
    if (term) {
      try { term.kill(); } catch { /* ignore */ }
      ptys.delete(key);
    }
  });
}

// Lifecycle helpers used by main.js outside the IPC path.

/** Kill every PTY owned by a destroyed webContents. */
function killForWebContents(webContentsId) {
  for (const [key, term] of ptys) {
    if (key.startsWith(`${webContentsId}:`)) {
      try { term.kill(); } catch { /* ignore */ }
      ptys.delete(key);
    }
  }
}

/** Kill every PTY (used by before-quit, before sessionLog closes). */
function killAll() {
  for (const [key, term] of ptys) {
    try { term.kill(); } catch { /* ignore */ }
    ptys.delete(key);
  }
}

module.exports = { register, killForWebContents, killAll };
