const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');
const { Agent } = require('../src/core/agent');
const { OllamaRunner } = require('../src/core/runners/ollama');
const { runToolLoop } = require('../src/core/toolLoop');
const { SessionLog } = require('../src/core/sessionLog');
const { snapshotBefore, summarizeWindow } = require('../src/core/claudeSessionScan');
const { mirrorAll, groupSessionsByProject } = require('../src/core/memoryMirror');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'project-output');
const SESSIONS_DIR = path.join(PROJECT_ROOT, '.myagent', 'sessions');
// Obsidian-friendly memory mirror: per-project memory + session index.
const MEMORIES_DIR = path.join(SESSIONS_DIR, 'memories');

// One shared runner so /think toggles persist across prompts.
const runner = new OllamaRunner();

// One log file per app launch. Captures everything that hits the
// terminals (agent + every PTY pane). Lives in .myagent/ which is
// gitignored. See src/core/sessionLog.js.
const sessionLog = new SessionLog({ dir: SESSIONS_DIR });

// PTY registry keyed by `${webContentsId}:${paneId}`. Each pane in the
// renderer can host its own PTY, so the same window may have several at
// once (one per pane). Once a shell exits its process is gone — `pty:start`
// always creates a fresh one for that key.
const ptys = new Map();
const ptyKey = (contentsId, paneId) => `${contentsId}:${paneId || 'main'}`;

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(PROJECT_ROOT, 'renderer', 'index.html'));

  win.webContents.on('destroyed', () => {
    const id = win.webContents.id;
    for (const [key, term] of ptys) {
      if (key.startsWith(`${id}:`)) {
        try { term.kill(); } catch { /* ignore */ }
        ptys.delete(key);
      }
    }
  });
}

ipcMain.handle('agent:health', async () => runner.health());

ipcMain.handle('agent:think-status', async () => ({
  think: runner.think,
  capabilities: runner.capabilities,
  model: runner.model,
}));

ipcMain.handle('agent:set-think', async (_e, on) => {
  const result = await runner.setThink(on);
  return { ...result, capabilities: runner.capabilities, model: runner.model };
});

ipcMain.on('agent:run', async (event, { sessionId, prompt }) => {
  const send = (channel, payload) =>
    event.sender.send(channel, { sessionId, ...payload });

  // Agent always runs in the main pane today. If we ever route it to
  // another pane, plumb the paneId through this handler.
  const PANE = 'main';
  sessionLog.text('agent-in', prompt, PANE);

  try {
    const agent = new Agent({ runner });

    const { truncated, reason } = await runToolLoop({
      agent,
      userPrompt: prompt,
      outputDir: OUTPUT_DIR,
      onChunk: (text) => {
        sessionLog.text('agent-out', text, PANE);
        send('agent:chunk', { text });
      },
      onToolStart: (info) => {
        sessionLog.append('tool-start', info, PANE);
        send('agent:tool-start', info);
      },
      onToolEnd: (info) => {
        sessionLog.append('tool-end', info, PANE);
        send('agent:tool-end', info);
      },
    });

    sessionLog.append('agent-done', { truncated: !!truncated, reason }, PANE);
    send('agent:done', { truncated: !!truncated, reason });
  } catch (err) {
    sessionLog.append('agent-error', { message: err.message }, PANE);
    send('agent:error', { message: err.message });
  }
});

// ---- PTY ----
// Picks a sensible interactive shell on Windows.
function defaultWindowsShell() {
  // Prefer pwsh if installed; otherwise PowerShell 5; otherwise cmd.
  const candidates = [
    process.env.COMSPEC && /pwsh/i.test(process.env.COMSPEC) ? process.env.COMSPEC : null,
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : null,
    process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'powershell.exe';
}

function defaultShell() {
  if (process.platform === 'win32') return defaultWindowsShell();
  return process.env.SHELL || '/bin/bash';
}

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
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: resolvedCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
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
        mirrorAll({ outRoot: MEMORIES_DIR, sessionsByProject: grouped });
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    // Final markdown sweep — picks up any projects whose memory changed
    // outside of a captured PTY window.
    mirrorAll({ outRoot: MEMORIES_DIR, sessionsByProject: {} });
  } catch { /* ignore */ }
  try { sessionLog.close(); } catch { /* ignore */ }
});
