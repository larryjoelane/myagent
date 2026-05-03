// Bridge between the Node main process and the renderer-hosted
// embedder. The semantic agent's router calls `embed(text, opts)`
// from main; this module fires an IPC request into the hidden
// BrowserWindow that runs @huggingface/transformers (which can hit
// WebGPU because onnxruntime-web is browser-only).
//
// Why a hidden window: the alternative is `onnxruntime-node`, which
// only supports CUDA/CoreML — not the integrated GPUs most users
// have. WebGPU through the renderer covers Intel/AMD/NVIDIA
// integrated and discrete uniformly via the OS's WebGPU
// implementation.
//
// API:
//   const bridge = createEmbedderBridge({ projectRoot, BrowserWindow });
//   await bridge.start();          // spawns the hidden window
//   const v = await bridge.embed('hello', { device: 'auto' });
//   const s = await bridge.status();
//   await bridge.stop();
//
// Concurrency: each embed() and status() gets a unique request id;
// pending replies are correlated by id. Calls made before start()
// queue and resolve once the window is ready.

const path = require('path');
const { ipcMain } = require('electron');
const crypto = require('crypto');

function makeId() { return crypto.randomBytes(8).toString('hex'); }

class EmbedderBridge {
  constructor({ projectRoot, BrowserWindow }) {
    if (!projectRoot) throw new Error('EmbedderBridge: projectRoot is required');
    if (!BrowserWindow) throw new Error('EmbedderBridge: BrowserWindow is required');
    this.projectRoot = projectRoot;
    this.BrowserWindow = BrowserWindow;
    this.win = null;
    this.ready = null;          // Promise<void>, resolves on first __init__ from host
    this.pending = new Map();   // id -> { resolve, reject, timer }
    this.cachedStatus = null;
    this._ipcWired = false;
  }

  async start() {
    if (this.win) return this.ready;
    this._wireIpc();
    const win = new this.BrowserWindow({
      show: false,
      // Tiny — never visible. Some Electron builds reject 0×0.
      width: 100,
      height: 100,
      webPreferences: {
        preload: path.join(this.projectRoot, 'electron', 'embedder-host-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,         // we need the preload to require('electron')
        // WebGPU requires no special flag in Electron 41 (Chromium 134
        // ships it stable), but explicitly enable in case a future
        // build flips defaults.
        webgl: true,
        offscreen: false,
      },
    });
    this.win = win;
    win.loadFile(path.join(this.projectRoot, 'renderer', 'embedder-host.html'));

    // ready resolves when the host posts its initial __init__ status.
    this.ready = new Promise((resolve, reject) => {
      this.pending.set('__init__', {
        resolve: (msg) => { this.cachedStatus = msg.status || null; resolve(this.cachedStatus); },
        reject,
        timer: setTimeout(() => {
          this.pending.delete('__init__');
          reject(new Error('embedder host failed to initialize within 30s'));
        }, 30_000),
      });
    });

    win.on('closed', () => {
      this.win = null;
      // Reject any in-flight requests so callers don't hang.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('embedder host closed'));
        this.pending.delete(id);
      }
    });

    return this.ready;
  }

  _wireIpc() {
    if (this._ipcWired) return;
    this._ipcWired = true;
    ipcMain.on('embedder:reply', (_e, msg) => {
      if (!msg || msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      // Two reply shapes:
      //   - terminal: { ok, ... }                       — resolves
      //               { ok: false, error }              — rejects
      //   - streaming chunk: { chunk: {...}, done: false }
      //               (no ok field; doesn't resolve, calls onChunk)
      if (msg.chunk !== undefined && !msg.done) {
        if (typeof p.onChunk === 'function') p.onChunk(msg.chunk);
        // Keep the entry — more chunks coming.
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'embedder reply failed'));
    });
  }

  // Send a request to the host and await its reply. When `onChunk`
  // is provided, intermediate `{chunk}` messages route there; the
  // final `{ok:true, done:true}` reply still resolves the promise.
  _request(type, payload, { timeoutMs = 60_000, onChunk } = {}) {
    if (!this.win) throw new Error('embedder bridge not started');
    const id = makeId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embedder ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onChunk });
      try {
        this.win.webContents.send('embedder:request', { id, type, payload });
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

  // Run text generation. Resolves with { text, tokensUsed,
  // tokensPerSec, modelLoadMs?, finishReason }. The `modelId`
  // option picks which model to use (must be a generative entry
  // from src/core/models/registry.js); device defaults to the
  // model's preferred device.
  //
  // First call for a model on a device pays the load cost — can
  // be many seconds for ~370MB Qwen on first run. Hence the long
  // default timeout.
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

  // Streaming variant — `onToken({token, cumulativeText, index})`
  // fires for each generated token. Resolves with the same final
  // shape as generate().
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

  // Open DevTools on the hidden embedder window — for verifying
  // WebGPU is actually firing. Detached so the tools window opens
  // separately rather than trying to dock against an invisible host.
  openDevTools() {
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('embedder bridge not started');
    }
    if (!this.win.webContents.isDevToolsOpened()) {
      this.win.webContents.openDevTools({ mode: 'detach' });
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
    // Warmup — pays the device's pipeline load + first-inference
    // shader compile cost so the timed runs measure steady state.
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
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch { /* ignore */ }
    }
    this.win = null;
    this.ready = null;
  }
}

function createEmbedderBridge(opts) { return new EmbedderBridge(opts); }

module.exports = { createEmbedderBridge, EmbedderBridge };
