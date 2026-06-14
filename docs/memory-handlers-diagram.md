# `electron/ipc/memory-handlers.js` — what it does & call flow

## What this file does

It registers three **IPC handlers** on the Electron main process that let the
renderer (and the model's memory tools) talk to the hybrid **FTS5 + vector
memory index**. It is intentionally thin: it validates/normalizes the request,
then forwards everything to `indexHost` (a `WorkerHost`) so all SQLite and
embedding work happens **off the main thread**, in a worker.

Chat memory now lives in **MySecondBrain** (one row per Q+A turn), so search and
store route to `searchTurns`/`storeTurn` — the old `rows` chat data is frozen.

### The three handlers

| IPC channel      | What it does                                                                 | Calls on `indexHost`              |
|------------------|------------------------------------------------------------------------------|-----------------------------------|
| `memory:search`  | Validates `query` is a non-empty string; builds `opts` from `limit`/`minConfidence`; returns `{ hits, totalCandidates, stats }`. Pulls non-enumerable `totalCandidates` off the result so it survives the IPC JSON roundtrip. | `searchTurns(opts)`, `stats()`    |
| `memory:ingest`  | Forces a re-ingest (DevTools-only; not in the UI). Returns fresh stats.       | `runIngest()` → then `stats()`    |
| `memory:store`   | Trims `text`; builds a provenance label via `freeformProvenance(body)`; stores the note as a MySecondBrain turn (`answer` = note text, `prompt` = provenance, `provider: 'note'`). | `storeTurn({...})`                |

### Local helper
- `freeformProvenance(body)` — pure function, no external calls. Builds a label
  like `[saved note · source: X · tags: a, b]` from `body.source` / `body.tags`.

## Dependencies (injected via `register(deps)`)

`register({ ipcMain, indexHost, runIngest })` is called from
`electron/main.js` inside `registerIpcHandlers()` (`memory-handlers.js` itself
imports **nothing** — all deps are passed in):

- `ipcMain` — Electron's IPC bus.
- `indexHost` — a `WorkerHost` instance (`src/core/sessionWorkerHost.js`),
  constructed in `main.js` with `INDEX_DB_PATH` / `SESSIONS_DIR`.
- `runIngest` — `main.js` closure: `() => indexHost.ensureIngested()`
  (single-flight, errors swallowed).

## Call diagram

```
 Renderer / model memory tool                electron/main.js
 (ipcRenderer.invoke 'memory:*')             registerIpcHandlers()
            │                                        │
            │                                        │ memoryHandlers.register({
            ▼                                        │   ipcMain, indexHost, runIngest })
 ┌─────────────────────────────────────────────────▼──────────────┐
 │            electron/ipc/memory-handlers.js                      │
 │                                                                 │
 │  'memory:search' ──validate──► indexHost.searchTurns(opts)      │
 │                   └───────────► indexHost.stats()               │
 │                                                                 │
 │  'memory:ingest' ────────────► runIngest() ─► indexHost.stats() │
 │                                  (= indexHost.ensureIngested)   │
 │                                                                 │
 │  'memory:store'  ──freeformProvenance()──► indexHost.storeTurn()│
 └───────────────────────────────┬─────────────────────────────────┘
                                 │  (postMessage over worker_threads)
                                 ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │      src/core/sessionWorkerHost.js   (WorkerHost — main thread)   │
 │   thin id-dispatcher: _send(op, args) → worker.postMessage       │
 │   searchTurns / storeTurn / stats / ingest / ensureIngested      │
 └───────────────────────────────┬───────────────────────────────────┘
                                 │  Worker (worker_threads)
                                 ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │      src/core/sessionWorker.js   (off-thread)                     │
 │   storeTurn  → sessionIndex.storeTurn(ensureDb(), payload)        │
 │   searchTurns→ sessionIndex.searchTurns(ensureDb(), query, opts)  │
 │   + FTS5 + vector embedding, MySecondBrain table (SQLite)         │
 └─────────────────────────────────────────────────────────────────┘
```

## When each path fires
- **`memory:search`** — on every chat/UI search; also the auto-context path in
  `main.js` calls `indexHost.searchTurns` directly (not through this handler).
- **`memory:ingest`** — manual only (DevTools), while iterating.
- **`memory:store`** — model's `memory_store` tool or a direct note save.
- **`runIngest`** is also kicked at startup (`setImmediate`) and shared via the
  single-flight `ensureIngested()` promise.

> Note: this file has no early-return on a missing/dead worker; the host
> respawns lazily on the next `_send`, and a crash rejects in-flight calls.

## Review observations (not bugs)

These came out of reading the file — none are defects, but they're worth
keeping in mind:

- **`totalCandidates` is read off a non-enumerable property on purpose.** In
  `memory:search`, the result array carries `totalCandidates` as a
  non-enumerable property, so it would be **dropped by the IPC JSON
  roundtrip**. The handler explicitly pulls it out into the returned object
  (falling back to `hits.length`). Easy to break if someone "simplifies" that
  line — keep the explicit extraction.

- **The file header comment is stale.** The top comment says *"memory:search
  runs an incremental ingest first so freshly-written turns are searchable as
  soon as agent:done fires."* The current code does **not** ingest before
  searching — chat turns are written synchronously to MySecondBrain on
  turn-end, so no pre-search ingest is needed. The comment describes the old
  file-ingest flow and should be updated to match.

- **Auto-context bypasses this handler.** The auto-context retrieval path in
  `main.js` calls `indexHost.searchTurns(...)` **directly**, not through
  `memory:search`. So this handler is not the only entry point to search — a
  change to search-shaping here won't affect auto-context.

- **`memory:ingest` is intentionally UI-less.** It's only reachable from
  DevTools while iterating (per its inline comment). Not dead code, but not
  wired to any button.
