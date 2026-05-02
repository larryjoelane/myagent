// Main-thread wrapper around sessionWorker.js. Spawns the worker once,
// hides the message-id dispatcher, and exposes a small async API that
// matches what sessionIndex.js used to expose synchronously.
//
// The IPC handler in electron/main.js and the HTTP routes in
// sessionServer.js both go through this host — that's the chokepoint
// that keeps SQLite + embedding work off the main thread, where they
// were stalling PTY keystroke handling.
//
// We deliberately keep this thin: no caching, no coalescing, no
// in-flight dedup. If those become useful (e.g. two simultaneous
// /search calls embedding the same query), add them here, not in the
// worker.

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_FILE = path.resolve(__dirname, 'sessionWorker.js');

class WorkerHost {
  constructor({ dbPath, sessionsDir }) {
    this.dbPath = dbPath;
    this.sessionsDir = sessionsDir;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closing = false;
  }

  // Lazy spawn — first call to any op brings the worker up. Saves the
  // ~80ms thread spawn cost for installs that never use search.
  _spawn() {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_FILE, {
      workerData: { dbPath: this.dbPath, sessionsDir: this.sessionsDir },
    });
    w.on('message', (msg) => {
      if (!msg || typeof msg.id !== 'number') return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.value);
      else slot.reject(new Error(msg.error || 'worker error'));
    });
    w.on('error', (err) => {
      // A worker crash rejects everything in flight and clears state so
      // the next call respawns. Without this, callers would hang
      // forever on a dead worker.
      for (const [, slot] of this.pending) slot.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    w.on('exit', () => {
      // Same cleanup on a clean exit — covers the case where the
      // worker decides to terminate itself for some reason.
      for (const [, slot] of this.pending) {
        slot.reject(new Error('worker exited'));
      }
      this.pending.clear();
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  _send(op, args) {
    if (this.closing) return Promise.reject(new Error('host closing'));
    const w = this._spawn();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, op, args });
    });
  }

  // --- Public API ---------------------------------------------------------
  ingest() { return this._send('ingest', {}); }
  search({ query, limit, kindFilter, minConfidence } = {}) {
    return this._send('search', { query, limit, kindFilter, minConfidence });
  }
  storeMemory({ text, source, tags, ts } = {}) {
    return this._send('storeMemory', { text, source, tags, ts });
  }
  stats() { return this._send('stats', {}); }

  // Single-flight ingest helper — multiple callers (startup, post-turn,
  // pre-search) can all `await ensureIngested()` and they'll share one
  // run. Failures are swallowed so a transient ingest hiccup doesn't
  // poison the rest of the app's flow.
  ensureIngested() {
    if (!this._ingestPromise) {
      this._ingestPromise = this.ingest()
        .catch(() => 0)
        .finally(() => { this._ingestPromise = null; });
    }
    return this._ingestPromise;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (!this.worker) return;
    try { await this._send('close', {}); } catch { /* ignore */ }
    try { await this.worker.terminate(); } catch { /* ignore */ }
    this.worker = null;
  }
}

module.exports = { WorkerHost };
