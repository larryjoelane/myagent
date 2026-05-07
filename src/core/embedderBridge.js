// Bridge between the Node main process and the renderer-hosted model
// Worker. The semantic agent's router calls `embed(text, opts)` from
// main; this module sends an IPC request into the chat renderer,
// which forwards it to a Web Worker that runs
// @huggingface/transformers against WebGPU.
//
// Why a Worker (was: hidden BrowserWindow): only browser-context JS
// can access WebGPU. `onnxruntime-node` is CPU/CUDA/CoreML only —
// not the integrated GPUs most users have. Going through a Web
// Worker keeps WebGPU access while avoiding the cost of a second
// renderer process; the Worker also runs off-thread, so the chat UI
// stays responsive while a model loads or generation streams.
//
// API (unchanged from the previous hidden-BW implementation — keep
// SemanticDriver and the rest of the consumers untouched):
//   const bridge = createEmbedderBridge({ getWebContents });
//   await bridge.start();          // resolves when the renderer
//                                   // loads model-bridge.js and
//                                   // posts model:ready
//   const v = await bridge.embed('hello', { device: 'auto' });
//   const s = await bridge.status();
//   await bridge.stop();
//
// Concurrency: each request gets a unique id; pending replies are
// correlated by id. Streaming generation calls keep the entry alive
// across multiple `chunk` messages until the terminal `done:true`.
//
// Caller responsibility: pass `getWebContents` — a function that
// returns the chat renderer's webContents (or null if not ready).
// We use a getter rather than the WebContents directly because the
// bridge is constructed during app startup, before the main window
// has finished loading. The first request will await the renderer's
// `model:ready` IPC.

const { ipcMain } = require('electron');
const crypto = require('crypto');

function makeId() { return crypto.randomBytes(8).toString('hex'); }

class EmbedderBridge {
  constructor({ getWebContents }) {
    if (typeof getWebContents !== 'function') {
      throw new Error('EmbedderBridge: getWebContents (function) is required');
    }
    this.getWebContents = getWebContents;
    /** @type {Promise<void> | null} */
    this.ready = null;
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any, onChunk?: (c: any) => void}>} */
    this.pending = new Map();
    this.cachedStatus = null;
    this._ipcWired = false;
    this._readyResolve = null;
  }

  // Resolve once the renderer's model-bridge.js has loaded and
  // announced itself via `model:ready`. Idempotent — calling start()
  // a second time returns the same Promise.
  async start() {
    if (this.ready) return this.ready;
    this._wireIpc();
    this.ready = new Promise((resolve) => {
      this._readyResolve = resolve;
      // Defensive timeout: if the renderer never posts model:ready
      // within 30s, log and resolve anyway. The first real request
      // will surface the underlying error.
      setTimeout(() => {
        if (this._readyResolve) {
          // eslint-disable-next-line no-console
          console.error('[embedder bridge] renderer did not signal ready within 30s');
          const r = this._readyResolve;
          this._readyResolve = null;
          r();
        }
      }, 30_000);
    });
    return this.ready;
  }

  _wireIpc() {
    if (this._ipcWired) return;
    this._ipcWired = true;

    ipcMain.on('model:ready', () => {
      if (this._readyResolve) {
        const r = this._readyResolve;
        this._readyResolve = null;
        r();
      }
    });

    ipcMain.on('model:reply', (_e, msg) => {
      if (!msg || msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'model reply failed'));
    });

    ipcMain.on('model:chunk', (_e, msg) => {
      if (!msg || msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (typeof p.onChunk === 'function') p.onChunk(msg.chunk);
      // Keep the entry — more chunks (and the terminal reply) coming.
    });
  }

  // Send a request to the host and await its reply. When `onChunk`
  // is provided, intermediate `{chunk}` messages route there; the
  // final terminal reply still resolves the promise.
  _request(type, payload, { timeoutMs = 60_000, onChunk } = {}) {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) {
      return Promise.reject(new Error('model bridge: chat renderer not available'));
    }
    const id = makeId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`model ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onChunk });
      try {
        wc.send('model:request', { id, type, payload });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async embed(text, opts = {}) {
    if (!this.ready) await this.start();
    await this.ready;
    // First inference on a device pays the model load cost. Allow a
    // generous timeout for the first call; subsequent ones land fast.
    const reply = await this._request('embed', { text, opts }, { timeoutMs: 120_000 });
    return new Float32Array(reply.vector);
  }

  async status() {
    if (!this.ready) await this.start();
    await this.ready;
    if (this.cachedStatus) {
      // Refresh in the background but return cached immediately so the
      // UI doesn't wait for a round-trip.
      this._request('status', {}, { timeoutMs: 10_000 })
        .then((reply) => { if (reply.status) this.cachedStatus = reply.status; })
        .catch(() => { /* ignore */ });
      return this.cachedStatus;
    }
    const reply = await this._request('status', {}, { timeoutMs: 10_000 });
    this.cachedStatus = reply.status || null;
    return this.cachedStatus;
  }

  async generate(prompt, opts = {}) {
    if (!this.ready) await this.start();
    await this.ready;
    const reply = await this._request('generate', { prompt, opts },
      { timeoutMs: opts.timeoutMs || 600_000 });
    return {
      text: reply.text,
      tokensUsed: reply.tokensUsed,
      tokensPerSec: reply.tokensPerSec,
      modelLoadMs: reply.modelLoadMs || 0,
      finishReason: reply.finishReason || 'stop',
    };
  }

  async generateStream(prompt, opts = {}, onToken) {
    if (!this.ready) await this.start();
    await this.ready;
    const reply = await this._request('generate', { prompt, opts: { ...opts, stream: true } },
      { timeoutMs: opts.timeoutMs || 600_000, onChunk: onToken });
    return {
      text: reply.text,
      tokensUsed: reply.tokensUsed,
      tokensPerSec: reply.tokensPerSec,
      modelLoadMs: reply.modelLoadMs || 0,
      finishReason: reply.finishReason || 'stop',
    };
  }

  async cacheStatus(modelId) {
    if (!this.ready) await this.start();
    await this.ready;
    return this._request('cache-status', { modelId }, { timeoutMs: 30_000 });
  }

  async warmup(modelId, opts = {}) {
    if (!this.ready) await this.start();
    await this.ready;
    return this._request('warmup', { modelId, opts }, { timeoutMs: 30 * 60_000 });
  }

  // Open DevTools on the chat renderer (where the Worker lives).
  // Workers show in the main renderer's DevTools as a separate
  // tab — there's no separate window to open anymore.
  openDevTools() {
    const wc = this.getWebContents();
    if (!wc || wc.isDestroyed()) {
      throw new Error('model bridge: chat renderer not available');
    }
    if (!wc.isDevToolsOpened()) {
      wc.openDevTools({ mode: 'detach' });
    }
    return { opened: true };
  }

  // Run a tiny embed N times and report timings. The renderer can
  // call this to give the user concrete proof that the chosen device
  // is faster (or slower!) than CPU. First call pays the model load,
  // so we run a warmup that we exclude from the reported numbers.
  async benchmark({ device = 'cpu', iterations = 20 } = {}) {
    if (!this.ready) await this.start();
    await this.ready;
    const text = 'the quick brown fox jumps over the lazy dog';
    await this.embed(text, { device });
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = Date.now();
      await this.embed(text, { device });
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const median = samples[Math.floor(samples.length / 2)];
    const mean = sum / samples.length;
    return {
      device, iterations,
      meanMs: +mean.toFixed(2),
      medianMs: median,
      minMs: samples[0],
      maxMs: samples[samples.length - 1],
      samples,
    };
  }

  async stop() {
    // Reject any in-flight requests so callers don't hang.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('model bridge: stopped'));
      this.pending.delete(id);
    }
    this.ready = null;
    this._readyResolve = null;
  }
}

function createEmbedderBridge(opts) { return new EmbedderBridge(opts); }

module.exports = { createEmbedderBridge, EmbedderBridge };
