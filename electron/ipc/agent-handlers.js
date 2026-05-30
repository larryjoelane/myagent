// IPC handlers for the agent registry — leader/worker mailbox so the
// HTTP routes at /agent/* and the in-renderer test panel share the same
// backing registry. The runner-controls + one-shot `agent:run` IPC that
// used to live here is gone: the renderer no longer has a single-agent
// surface, all chat goes through the worker channel layer
// (electron/ipc/worker-handlers.js) backed by per-agent drivers.
//
// Wired in from electron/main.js via register(deps).

/**
 * @typedef {object} AgentHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {ReturnType<typeof import('../../src/core/agentRegistry').createAgentRegistry>} agentRegistry
 */

/** @param {AgentHandlerDeps} deps */
function register({ ipcMain, agentRegistry }) {
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
