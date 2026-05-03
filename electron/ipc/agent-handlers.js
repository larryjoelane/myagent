// IPC handlers for the agent surface:
//   - agent:health / think-status / set-think / runners — per-runner controls
//     (the renderer passes runnerName + model on every call so main is
//     stateless w.r.t. which runner is "current")
//   - agent:run — one-shot tool-loop run for the embedded Agent (Ollama-backed
//     today). Streams chunks/tool events back to the same sender.
//   - agent:register/heartbeat/send/inbox/list/unregister/rename — leader/worker
//     registry. Same shape as the /agent/* HTTP routes; the registry behind
//     both paths is the same object.
//
// Wired in from electron/main.js via register(deps).

const { Agent } = require('../../src/core/agent');
const { REGISTRY } = require('../../src/core/runners');
const { runToolLoop } = require('../../src/core/toolLoop');

/**
 * @typedef {object} AgentHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {(opts: { runnerName?: string, model?: string }) => any} getRunner
 * @property {ReturnType<typeof import('../../src/core/agentRegistry').createAgentRegistry>} agentRegistry
 * @property {import('../../src/core/sessionLog').SessionLog} sessionLog
 * @property {string} outputDir
 * @property {() => Promise<unknown>} runIngest
 */

/** @param {AgentHandlerDeps} deps */
function register({ ipcMain, getRunner, agentRegistry, sessionLog, outputDir, runIngest }) {
  // --- Runner controls ----------------------------------------------------

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

  // --- One-shot agent run -------------------------------------------------

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
        outputDir,
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
    // Pick up the lines we just appended (agent-in + agent-out chunks) so
    // search reflects the latest turn. The session log writes are async to
    // disk, so wait one tick before re-scanning the file.
    setImmediate(() => { runIngest(); });
  });

  // --- Agent registry -----------------------------------------------------
  // Same shape as the /agent/* HTTP routes, exposed in-process so the
  // renderer test panel can drive register/list/send/inbox without going
  // through HTTP.

  ipcMain.handle('agent:register', async (_e, body = {}) => {
    try { return { ok: true, ...agentRegistry.register(body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('agent:heartbeat', async (_e, body = {}) => {
    try { return { ok: true, ...agentRegistry.heartbeat(body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('agent:send', async (_e, body = {}) => {
    try { return { ok: true, ...agentRegistry.send(body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('agent:inbox', async (_e, body = {}) => {
    try { return { ok: true, messages: agentRegistry.inbox(body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('agent:list', async () => {
    return { ok: true, agents: agentRegistry.list() };
  });
  ipcMain.handle('agent:unregister', async (_e, body = {}) => {
    return { ok: true, ...agentRegistry.unregister(body) };
  });
  ipcMain.handle('agent:rename', async (_e, body = {}) => {
    try { return { ok: true, ...agentRegistry.rename(body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { register };
