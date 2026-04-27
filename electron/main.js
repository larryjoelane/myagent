const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');
const { Agent } = require('../src/core/agent');
const { createRunner, REGISTRY } = require('../src/core/runners');
const { runToolLoop } = require('../src/core/toolLoop');
const { SessionLog } = require('../src/core/sessionLog');
const { snapshotBefore, summarizeWindow } = require('../src/core/claudeSessionScan');
const { mirrorAll, groupSessionsByProject } = require('../src/core/memoryMirror');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'project-output');
const SESSIONS_DIR = path.join(PROJECT_ROOT, '.myagent', 'sessions');
// Obsidian-friendly memory mirror: per-project memory + session index.
const MEMORIES_DIR = path.join(SESSIONS_DIR, 'memories');

// Runner cache keyed by `${runnerName}::${model}`. Lazy — no runner is
// constructed (and no Ollama / model service is touched) until an
// `agent:*` IPC actually arrives. The renderer no longer calls these on
// startup; the agent UI was removed and will be rebuilt later.
const runnerCache = new Map();
function getRunner({ runnerName = 'ollama', model } = {}) {
  const key = `${runnerName}::${model || ''}`;
  if (!runnerCache.has(key)) {
    const opts = model ? { model } : {};
    runnerCache.set(key, createRunner(runnerName, opts));
  }
  return runnerCache.get(key);
}

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

// Application menu. Replaces Electron's default so we can add a DevTools
// toggle for the renderer (Ctrl+Shift+I or View → Toggle Developer Tools).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: (_item, win) => {
            const target = win || BrowserWindow.getFocusedWindow();
            target?.webContents.toggleDevTools();
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

// Health/think-status/set-think target the runner the renderer last used
// for this session. The renderer passes runnerName + model on every call
// so the main process is stateless w.r.t. which runner is "current."
ipcMain.handle('agent:health', async (_e, opts = {}) => getRunner(opts).health());

ipcMain.handle('agent:think-status', async (_e, opts = {}) => {
  const r = getRunner(opts);
  return { think: r.think, capabilities: r.capabilities, model: r.model };
});

ipcMain.handle('agent:set-think', async (_e, { on, ...opts } = {}) => {
  const r = getRunner(opts);
  const result = await r.setThink(on);
  return { ...result, capabilities: r.capabilities, model: r.model };
});

// List installed runners so the renderer can validate /agent --runner X.
ipcMain.handle('agent:runners', async () => Object.keys(REGISTRY));

ipcMain.on('agent:run', async (event, { sessionId, prompt, runnerName, model } = {}) => {
  const send = (channel, payload) =>
    event.sender.send(channel, { sessionId, ...payload });

  const PANE = 'main';
  sessionLog.text('agent-in', prompt, PANE);

  try {
    const runner = getRunner({ runnerName, model });
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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Set to true after the deferred shutdown so we don't loop on the
// before-quit event when app.quit() resumes.
let shutdownDone = false;
app.on('before-quit', (ev) => {
  if (shutdownDone) return;
  ev.preventDefault();
  // Kill any live PTYs first so their onExit handlers run while the
  // session log + raw streams are still open. Without this, the PTYs
  // are torn down by the OS *after* sessionLog.close(), and the late
  // pty-exit / pty-agent-summary writes hit an ended stream ("write
  // after end") and the memory mirror they trigger never lands.
  for (const [key, term] of ptys) {
    try { term.kill(); } catch { /* ignore */ }
    ptys.delete(key);
  }
  // Give the PTY onExit handlers a moment to fire — they emit the final
  // pty-exit / pty-agent-summary lines and refresh the memory mirror
  // for sessions that were still running. 250ms is enough on Windows
  // ConPTY in practice without making quit feel laggy.
  setTimeout(() => {
    try {
      // Final memory sweep — picks up any projects whose memory changed
      // outside of a captured PTY window.
      mirrorAll({ outRoot: MEMORIES_DIR, sessionsByProject: {} });
    } catch { /* ignore */ }
    try { sessionLog.close(); } catch { /* ignore */ }
    shutdownDone = true;
    app.quit();
  }, 250);
});
