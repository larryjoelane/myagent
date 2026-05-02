// Worker-thread entry. Owns the SQLite connection and the embedder so
// the main thread never blocks on either — that's what was making PTY
// keystrokes lag (model load is ~3s synchronous WASM init, embedding is
// ~30-80ms per row, both on whichever thread runs them).
//
// Protocol: messages from the host are { id, op, args }, replies are
// { id, ok: true, value } or { id, ok: false, error }. The worker
// processes ops sequentially — better-sqlite3 is synchronous and the
// embedder pipeline isn't reentrant anyway, so there's no upside to
// concurrency inside one worker.
//
// Lifecycle: the worker stays alive for the lifetime of the Electron
// main process. The host calls `op: 'close'` on shutdown.

const { parentPort, workerData } = require('worker_threads');

if (!parentPort) {
  // Defensive — this file is only meant to be loaded as a Worker.
  throw new Error('sessionWorker.js must be run inside worker_threads');
}

const sessionIndex = require('./sessionIndex');

const { dbPath, sessionsDir } = workerData || {};
let db = null;

function ensureDb() {
  if (!db) db = sessionIndex.open(dbPath);
  return db;
}

// Op handlers. Each returns the value to send back; throwing converts
// to a rejected reply on the host side.
const OPS = {
  async ingest() {
    return sessionIndex.ingestDir(ensureDb(), sessionsDir);
  },
  async search({ query, limit, kindFilter, minConfidence }) {
    const opts = { kindFilter };
    if (typeof limit === 'number') opts.limit = limit;
    if (typeof minConfidence === 'number') opts.minConfidence = minConfidence;
    return sessionIndex.search(ensureDb(), query, opts);
  },
  async storeMemory({ text, source, tags, ts }) {
    return sessionIndex.storeMemory(ensureDb(), { text, source, tags, ts });
  },
  stats() {
    return sessionIndex.stats(ensureDb());
  },
  close() {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
    }
    return { closed: true };
  },
};

parentPort.on('message', async (msg) => {
  const { id, op, args } = msg || {};
  const handler = OPS[op];
  if (!handler) {
    parentPort.postMessage({ id, ok: false, error: `unknown op: ${op}` });
    return;
  }
  try {
    const value = await handler(args || {});
    parentPort.postMessage({ id, ok: true, value });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
});
