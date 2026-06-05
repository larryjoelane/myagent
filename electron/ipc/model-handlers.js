// IPC handlers for the model surface — embedder status, benchmarks,
// generation, and the cache/warmup helpers. All work routes through the
// embedder bridge (a hidden BrowserWindow that hosts @huggingface/transformers
// against WebGPU). The bridge is created lazily so the WebGPU window isn't
// spawned until the user actually needs an embedding or generation.
//
// Wired in from electron/main.js via register(deps).

/**
 * @typedef {object} ModelHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {() => ReturnType<typeof import('../../src/core/embedderBridge').createEmbedderBridge>} getEmbedderBridge
 */

/** @param {ModelHandlerDeps} deps */
function register({ ipcMain, getEmbedderBridge }) {
  // Embedder status from the bridge (real WebGPU detection — the
  // hidden renderer probes navigator.gpu and reports back). Used by
  // the renderer to populate the Device dropdown in the model settings
  // UI honestly — if WebGPU isn't available we say so rather than
  // silently falling back.
  ipcMain.handle('models:embedder-status', async () => {
    try {
      const bridge = getEmbedderBridge();
      const status = await bridge.status();
      return { ok: true, ...status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Open DevTools on the hidden embedder window. Useful for verifying
  // WebGPU actually fires (chrome://gpu, console, perf timeline).
  ipcMain.handle('models:embedder-devtools', () => {
    try {
      const bridge = getEmbedderBridge();
      return { ok: true, ...bridge.openDevTools() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Benchmark a device — runs N embeds with warmup and returns
  // timings. Renderer surfaces this in the Device row so the user
  // has concrete numbers, not vibes.
  ipcMain.handle('models:embedder-benchmark', async (_e, body = {}) => {
    try {
      const bridge = getEmbedderBridge();
      const r = await bridge.benchmark({
        device: body.device || 'cpu',
        iterations: Math.min(50, Math.max(5, body.iterations || 20)),
      });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Model registry — list all known models, optionally filtered by
  // kind ('embed' | 'generate'). Renderer uses this to populate the
  // generation-model picker.
  ipcMain.handle('models:list', (_e, body = {}) => {
    try {
      const registry = require('../../src/core/models/registry');
      return { ok: true, models: registry.list(body.kind || null) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Inspect the renderer's transformers cache for a given model id.
  // Used by the UI to show "downloaded ✓ / will download" status next
  // to each entry in the Explain Model dropdown.
  ipcMain.handle('models:cache-status', async (_e, body = {}) => {
    try {
      const bridge = getEmbedderBridge();
      const r = await bridge.cacheStatus(body.modelId);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Pre-load a model into memory (and download it if not cached) so
  // the user can pay the cost deliberately instead of triggering it
  // invisibly on first inference.
  ipcMain.handle('models:warmup', async (_e, body = {}) => {
    try {
      const bridge = getEmbedderBridge();
      const r = await bridge.warmup(body.modelId, { device: body.device });
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Run a generation. When `stream: true`, intermediate token chunks
  // are forwarded to the renderer via `models:generate-chunk` events
  // (correlated by the requestId we return). Resolves with the final
  // stats once generation completes.
  ipcMain.handle('models:generate', async (event, body = {}) => {
    try {
      const bridge = getEmbedderBridge();
      const onToken = body.stream
        ? (chunk) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('models:generate-chunk', { requestId: body.requestId, ...chunk });
            }
          }
        : null;
      const r = body.stream
        ? await bridge.generateStream(body.prompt || '', body.opts || {}, onToken)
        : await bridge.generate(body.prompt || '', body.opts || {});
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { register };
