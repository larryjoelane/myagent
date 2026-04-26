const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Agent } = require('../src/core/agent');
const { OllamaRunner } = require('../src/core/runners/ollama');
const { runToolLoop } = require('../src/core/toolLoop');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'project-output');

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
}

ipcMain.handle('agent:health', async () => {
  const runner = new OllamaRunner();
  return runner.health();
});

ipcMain.on('agent:run', async (event, { sessionId, prompt }) => {
  const send = (channel, payload) =>
    event.sender.send(channel, { sessionId, ...payload });

  try {
    const runner = new OllamaRunner();
    const agent = new Agent({ runner });

    const { truncated, reason } = await runToolLoop({
      agent,
      userPrompt: prompt,
      outputDir: OUTPUT_DIR,
      onChunk: (text) => send('agent:chunk', { text }),
      onToolStart: (info) => send('agent:tool-start', info),
      onToolEnd: (info) => send('agent:tool-end', info),
    });

    send('agent:done', { truncated: !!truncated, reason });
  } catch (err) {
    send('agent:error', { message: err.message });
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
