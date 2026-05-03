// IPC handlers for the hybrid (FTS5 + vector) memory index. All work is
// routed through the worker host so the main thread doesn't block on
// SQLite or embedding. memory:search runs an incremental ingest first so
// freshly-written turns are searchable as soon as agent:done fires.
//
// Wired in from electron/main.js via register(deps).

/**
 * @typedef {object} MemoryHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('../../src/core/sessionWorkerHost').WorkerHost} indexHost
 * @property {() => Promise<unknown>} runIngest
 */

/** @param {MemoryHandlerDeps} deps */
function register({ ipcMain, indexHost, runIngest }) {
  ipcMain.handle('memory:search', async (_e, body = {}) => {
    const { query, limit, kindFilter, minConfidence } = body;
    if (!query || typeof query !== 'string') return { hits: [], totalCandidates: 0, stats: null };
    await runIngest();
    const opts = { query, kindFilter: kindFilter || null };
    // Only pass limit when caller specified one — sessionIndex.search
    // falls back to its default of 10. Threshold-only queries (no
    // explicit limit) intentionally leave limit undefined so the
    // search returns all rows ≥ threshold. See docs/memory-search.md.
    if (typeof limit === 'number') opts.limit = limit;
    if (typeof minConfidence === 'number' && minConfidence > 0) {
      opts.minConfidence = minConfidence;
    }
    const hits = await indexHost.search(opts);
    // hits is an Array with a non-enumerable totalCandidates property —
    // pull it out explicitly so it survives the IPC JSON roundtrip.
    const totalCandidates = (hits && typeof hits.totalCandidates === 'number')
      ? hits.totalCandidates
      : hits.length;
    return { hits, totalCandidates, stats: await indexHost.stats() };
  });

  // Force a re-ingest. Useful from DevTools while iterating; not currently
  // exposed in the UI.
  ipcMain.handle('memory:ingest', async () => {
    await runIngest();
    return indexHost.stats();
  });

  // Write a freeform memory directly to the index. Mirrors the
  // /memory/store HTTP route but stays in-process so the renderer test
  // panel doesn't need to talk to the loopback server.
  ipcMain.handle('memory:store', async (_e, body = {}) => {
    return indexHost.storeMemory(body);
  });
}

module.exports = { register };
