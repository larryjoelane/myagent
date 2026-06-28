// IPC handlers for the worker surface (chat-driven agents and shells)
// plus a few small adjacent surfaces:
//   - worker:spawn / list / list-tools / send / close / rename
//   - dialog:choose-directory — native picker for a worker's cwd
//   - dialog:save-file — native save-as dialog for the editor
//   - settings:get / set — generic persisted UI settings
//   - chat:get-settings / set-default-mirror / set-worker-mirror —
//     memory-mirror controls
//
// Wired in from electron/main.js via register(deps).

const path = require('path');

/**
 * @typedef {object} WorkerHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('electron').BrowserWindow} BrowserWindow
 * @property {import('electron').Dialog} dialog
 * @property {import('../../src/core/workerManager').WorkerManager} workerManager
 * @property {import('../../src/core/appSettings').AppSettings} appSettings
 * @property {string} projectRoot
 * @property {{ push: (id: string, absPath: string, deployInfo: any) => Promise<any>, closeFor: (id: string) => void }} [flySync]
 *   Manages FlySyncSession instances keyed by worker id — injectable so
 *   tests can stub it. Wired in main.js to a FlySyncManager
 *   (src/core/fly/flySyncManager.js).
 * @property {() => (import('../../src/core/fly/flyClient').FlyClient | null)} [getFlyClient]
 *   Lazy accessor for a FlyClient instance (null when FLY_API_TOKEN is
 *   unset) — used by worker:fly-list-machines to list candidate machines
 *   for the "attach to existing" dropdown, independent of any worker.
 */

/** @param {WorkerHandlerDeps} deps */
function register({ ipcMain, BrowserWindow, dialog, workerManager, appSettings, projectRoot, flySync, getFlyClient }) {
  // --- Worker management --------------------------------------------------
  // Workers are headless agents (shell / local / ollama-cloud / openrouter)
  // the chat drives. openrouter is the default kind.
  ipcMain.handle('worker:spawn', async (_e, body = {}) => {
    try {
      const kind = body.kind === 'shell'         ? 'shell'
                 : body.kind === 'ollama-cloud'  ? 'ollama-cloud'
                 : body.kind === 'local'         ? 'local'
<<<<<<< HEAD
                 : body.kind === 'huggingface'   ? 'huggingface'
=======
                 : body.kind === 'fly'           ? 'fly'
>>>>>>> f70b14ef8b2381f43a221d0045b0b31d369e4bd6
                 : body.kind === 'openrouter'    ? 'openrouter'
                                                 : 'openrouter';
      const cwd = body.cwd || appSettings.get('lastCwd') || projectRoot;
      let result;
      if (kind === 'shell') {
        result = await workerManager.spawnShell({ name: body.name, cwd });
      } else if (kind === 'local') {
        result = await workerManager.spawnLocal({ name: body.name, cwd, model: body.model });
      } else if (kind === 'fly') {
        result = await workerManager.spawnFly({ name: body.name, appName: body.appName });
      } else if (kind === 'ollama-cloud') {
        result = await workerManager.spawnOllamaCloud({
          name: body.name, cwd, model: body.model,
          maxIterations: body.maxIterations,
          envContext: body.envContext,
          parallelDispatch: body.parallelDispatch,
        });
      } else if (kind === 'huggingface') {
        result = await workerManager.spawnHuggingFace({
          name: body.name, cwd, model: body.model,
          maxIterations: body.maxIterations,
          envContext: body.envContext,
          parallelDispatch: body.parallelDispatch,
        });
      } else {
        // openrouter — the default kind.
        result = await workerManager.spawnOpenRouter({
          name: body.name, cwd, model: body.model,
          maxIterations: body.maxIterations,
          envContext: body.envContext,
          parallelDispatch: body.parallelDispatch,
        });
      }
      // Remember this cwd as the new default for the next spawn.
      if (cwd) appSettings.set('lastCwd', cwd);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Native directory picker for choosing a worker's cwd. Defaults to
  // the last-used cwd (or project root) so users land in a sensible
  // place without scrolling.
  ipcMain.handle('dialog:choose-directory', async (event, body = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = body.defaultPath || appSettings.get('lastCwd') || projectRoot;
    const result = await dialog.showOpenDialog(win, {
      title: body.title || 'Choose worker directory',
      defaultPath,
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const chosen = result.filePaths[0];
    return { canceled: false, path: chosen };
  });

  // Native save-file dialog. Used by the editor's "Save As" button.
  // The renderer takes the returned path and writes via fs:write-file
  // (which enforces scope) — main does no I/O here.
  ipcMain.handle('dialog:save-file', async (event, body = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = body.defaultPath || appSettings.get('editorRoot')
      || appSettings.get('lastCwd') || projectRoot;
    const result = await dialog.showSaveDialog(win, {
      title: body.title || 'Save As',
      defaultPath,
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, path: result.filePath };
  });

  // Get/set persisted settings — currently just lastCwd, but the IPC
  // is generic so future settings (theme, permission mode default)
  // don't need new handlers.
  ipcMain.handle('settings:get', (_e, { key, fallback } = {}) =>
    ({ value: appSettings.get(key, fallback) }));
  ipcMain.handle('settings:set', (_e, { key, value } = {}) => {
    appSettings.set(key, value);
    return { ok: true };
  });

  ipcMain.handle('worker:list', () => ({ ok: true, workers: workerManager.list() }));

  // Ollama Cloud model picker. Reads OLLAMA_MODELS (comma-separated)
  // from .env; falls back to a curated default list of -cloud tags.
  // OLLAMA_MODEL (when set) overrides which entry is selected by
  // default; otherwise we default to devstral-small-2:24b-cloud.
  //
  // Cloud-only by design: this driver hits https://ollama.com/api/chat
  // which only serves models with the -cloud suffix. Local-only tags
  // (gemma3n:e2b, ibm/granite-docling, etc.) live in a separate worker
  // kind that hits the local Ollama daemon — see
  // todo_local_ollama_worker.md.
  ipcMain.handle('worker:ollama-cloud-models', () => {
    const raw = (process.env.OLLAMA_MODELS || '').trim();
    const models = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [
          'ministral-3:3b-cloud',
          'gpt-oss:20b-cloud',
          'gpt-oss:120b-cloud',
          'devstral-small-2:24b-cloud',
          'qwen3-coder-next:cloud',
          'qwen3-coder:480b-cloud',
          'kimi-k2:1t-cloud',
          'glm-4.6:cloud',
          'glm-5.1:cloud',
        ];
    const envDefault = (process.env.OLLAMA_MODEL || '').trim();
    // Default to devstral-small-2:24b-cloud — Mistral's agentic coding
    // model, ~24B, free-tier ("Low Usage") on Ollama Cloud. Coder-tuned
    // and reliable with OpenAI-format tool calls, which is what
    // ToolUseLoop emits. Fall back through ministral-3 (smaller, also
    // free-tier) then whatever the user's list provides.
    const def = envDefault
      || (models.includes('devstral-small-2:24b-cloud') ? 'devstral-small-2:24b-cloud'
        : models.includes('ministral-3:3b-cloud') ? 'ministral-3:3b-cloud'
        : models[0] || '');
    return { ok: true, models, default: def };
  });

  // Model list for the OpenRouter spawn dropdown. Mirrors the ollama-cloud
  // handler: OPENROUTER_MODELS (comma-separated) overrides the built-in
  // default set; OPENROUTER_MODEL is the default selection. OpenRouter model
  // ids are `vendor/model` slugs. Env-driven by design — no network call
  // here; the live catalog has hundreds of entries.
  ipcMain.handle('worker:openrouter-models', () => {
    const raw = (process.env.OPENROUTER_MODELS || '').trim();
    const models = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : [
          'openai/gpt-5-nano',
          'openai/gpt-4o-mini',
          'z-ai/glm-5.2',
          'qwen/qwen3-coder-30b-a3b-instruct',
        ];
    // GPT-5-nano is the default selection; env OPENROUTER_MODEL overrides.
    const def = (process.env.OPENROUTER_MODEL || '').trim() || 'openai/gpt-5-nano';
    return { ok: true, models, default: def };
  });

  // Tool list for a single worker, when its driver exposes a toolkit.
  // Returns {ok:true, tools:[...]} or {ok:false, error} when the worker
  // doesn't exist / has no toolkit. Renderer uses this to drive
  // the slash-command autocomplete popup.
  ipcMain.handle('worker:list-tools', (_e, body = {}) => {
    const tools = workerManager.listTools(body.id);
    if (!tools) return { ok: false, error: 'no toolkit for worker' };
    return { ok: true, tools };
  });

  ipcMain.handle('worker:send', (_e, body = {}) => {
    workerManager.send({
      to: body.to,
      text: body.text,
      originalText: body.originalText,
    });
    return { ok: true };
  });

  ipcMain.handle('worker:cancel', (_e, { id } = {}) => {
    return workerManager.cancel(id);
  });

  // Push a file or folder to the Fly machine attached to worker `id`,
  // and start auto-watching it so subsequent saves sync live (Replit-style —
  // no rebuild/redeploy). The worker must be a `fly` kind that has already
  // bootstrapped a machine (i.e. send() succeeded at least once).
  ipcMain.handle('worker:fly-push', async (_e, { id, path: target, cwd } = {}) => {
    if (!target || typeof target !== 'string') {
      return { ok: false, error: 'path is required' };
    }
    // A relative path is resolved against the renderer's current "Working
    // dir" (cwd, passed through from state.pendingCwd), falling back to
    // projectRoot — never the Electron process's own cwd, which is the
    // app's install directory and almost never what the user means.
    const absTarget = path.isAbsolute(target)
      ? target
      : path.resolve(cwd || appSettings.get('lastCwd') || projectRoot, target);
    const deployInfo = workerManager.getFlyDeployInfo(id);
    if (!deployInfo) {
      return { ok: false, error: 'no Fly machine attached — spawn/deploy a Fly worker first' };
    }
    if (!flySync) return { ok: false, error: 'fly sync is not available' };
    try {
      return await flySync.push(id, absTarget, deployInfo);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // List existing machines for a Fly app name, so the settings-drawer can
  // offer a dropdown of machines to attach to instead of always creating a
  // new one. Independent of any spawned worker — only needs a FlyClient.
  ipcMain.handle('worker:fly-list-machines', async (_e, { appName } = {}) => {
    if (!appName || typeof appName !== 'string') {
      return { ok: false, error: 'appName is required' };
    }
    const client = typeof getFlyClient === 'function' ? getFlyClient() : null;
    if (!client) return { ok: false, error: 'FLY_API_TOKEN not set in .env' };
    try {
      const machines = await client.listMachines(appName);
      return {
        ok: true,
        machines: (machines || []).map((m) => ({
          id: m.id, name: m.name, state: m.state, region: m.region,
        })),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Attach a Fly worker to an already-existing machine instead of creating
  // one. The driver checks (then injects if needed) the sync agent on the
  // existing machine — see FlyDeployDriver.attach / attachToSyncMachine.
  // machineId is optional: when omitted, workerManager.attachFly() falls
  // back to the worker's own lastDeploy machine, which is what makes this
  // double as the "restart sync" action on an already-attached worker.
  ipcMain.handle('worker:fly-attach', async (_e, { id, machineId } = {}) => {
    if (machineId !== undefined && typeof machineId !== 'string') {
      return { ok: false, error: 'machineId must be a string when provided' };
    }
    try {
      return await workerManager.attachFly(id, machineId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Pure status check for a fly worker's sync agent — used by the
  // settings-drawer to show a live/dead indicator and decide whether to
  // surface a "Restart sync" action, without side effects.
  ipcMain.handle('worker:fly-check-sync', async (_e, { id } = {}) => {
    try {
      return await workerManager.checkFlySync(id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('worker:close', async (_e, { id } = {}) => {
    await workerManager.close(id);
    if (flySync && typeof flySync.closeFor === 'function') flySync.closeFor(id);
    return { ok: true };
  });

  ipcMain.handle('worker:rename', (_e, body = {}) => {
    try { return { ok: true, ...workerManager.rename(body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // --- Per-worker scope (ADR-0008) ---------------------------------------

  ipcMain.handle('worker:list-scope', (_e, { id } = {}) => {
    return workerManager.listScope({ id });
  });

  ipcMain.handle('worker:add-scope', async (event, { id, path: dir } = {}) => {
    // If no path provided, open the native picker so the renderer can
    // skip the round-trip. Returning canceled is fine — the UI just
    // does nothing.
    let chosen = dir;
    if (!chosen) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: 'Add scope directory',
        defaultPath: appSettings.get('lastCwd') || projectRoot,
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
      chosen = result.filePaths[0];
    }
    return await workerManager.addScope({ id, path: chosen });
  });

  ipcMain.handle('worker:remove-scope', async (_e, { id, path: dir } = {}) => {
    return await workerManager.removeScope({ id, path: dir });
  });

  // --- Memory-mirror controls ---------------------------------------------
  ipcMain.handle('chat:get-settings', () => ({
    defaultMirror: workerManager.memoryMirrorDefault,
    workers: workerManager.list().map((w) => ({ id: w.id, memoryMirror: w.memoryMirror })),
  }));
  ipcMain.handle('chat:set-default-mirror', (_e, { on } = {}) => {
    workerManager.memoryMirrorDefault = !!on;
    return { ok: true, defaultMirror: workerManager.memoryMirrorDefault };
  });
  ipcMain.handle('chat:set-worker-mirror', (_e, { id, on } = {}) => {
    return { ok: true, ...workerManager.setMirror({ id, on: on === null ? null : !!on }) };
  });
}

module.exports = { register };
