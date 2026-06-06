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
    const { query, limit, minConfidence } = body;
    if (!query || typeof query !== 'string') return { hits: [], totalCandidates: 0, stats: null };
    // Chat memory now lives in MySecondBrain (one row per Q+A turn), written
    // synchronously on turn-end — no file ingest needed for it. We search
    // ONLY MySecondBrain (the old `rows` chat data is frozen until migrated).
    const opts = { query };
    if (typeof limit === 'number') opts.limit = limit;
    if (typeof minConfidence === 'number' && minConfidence > 0) {
      opts.minConfidence = minConfidence;
    }
    const hits = await indexHost.searchTurns(opts);
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

  // Write a freeform memory (e.g. the model's memory_store tool, or a direct
  // note). Routed into MySecondBrain so it's findable by the same search that
  // serves chat turns: the note text becomes the `answer`, and `prompt` holds
  // a provenance label (what caused the note) so it's tied to its trigger and
  // distinguishable from a real Q+A pair.
  ipcMain.handle('memory:store', async (_e, body = {}) => {
    const text = String(body.text || '').trim();
    if (!text) return { ok: false, error: 'empty text' };
    const prompt = freeformProvenance(body);
    return indexHost.storeTurn({
      prompt,
      answer: text,
      provider: 'note',
      ts: body.ts || undefined,
    });
  });
}

// Build a provenance label for a freeform note from its source/tags, so the
// stored turn records WHAT caused the note (not an empty prompt).
function freeformProvenance(body) {
  const source = body.source ? String(body.source).trim() : '';
  const tags = Array.isArray(body.tags) ? body.tags.filter(Boolean) : [];
  const parts = ['saved note'];
  if (source) parts.push(`source: ${source}`);
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`);
  return `[${parts.join(' · ')}]`;
}

module.exports = { register };
