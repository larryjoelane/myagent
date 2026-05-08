// Searchable index over the NDJSON session logs that sessionLog.js writes
// to .myagent/sessions/. Stores rows in SQLite with both an FTS5 index
// (BM25 keyword) and a vectors table (cosine semantic), and merges results
// at query time with reciprocal-rank fusion.
//
// What gets indexed:
//   - agent-in        user prompts
//   - agent-out       assistant streamed text (chunked at ~500 tokens)
//   - pty-agent-summary   one row per `claude` invocation, body is a small
//                         summary string built from sessionId/model/cwd
// Skipped:
//   - pty-in / pty-out    raw terminal noise; ANSI-stripped but still drowns FTS
//   - tool-start / tool-end / agent-done   structural, not searchable text
//
// Resumable ingest: for each NDJSON file we remember the byte offset we've
// read up to in the `ingest_cursor` table. Re-running ingest re-opens the
// file at that offset and appends only new lines. NDJSON is append-only so
// this is safe; if a file is rewritten (rare) the cursor will overshoot
// and we just stop early.

const fs = require('fs');
const path = require('path');
const { embed, vectorToBlob, blobToVector, cosine, DIM } = require('./embedder');

let Database;
function loadDriver() {
  if (!Database) Database = require('better-sqlite3');
  return Database;
}

// --- Schema ---------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT    NOT NULL,
  line_no     INTEGER NOT NULL,
  byte_off    INTEGER NOT NULL,
  ts          TEXT    NOT NULL,
  pane        TEXT,
  kind        TEXT    NOT NULL,
  session_id  TEXT,
  text        TEXT    NOT NULL,
  UNIQUE(file, line_no)
);
CREATE INDEX IF NOT EXISTS rows_kind_ts ON rows(kind, ts);
CREATE INDEX IF NOT EXISTS rows_session ON rows(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(
  text,
  content='rows',
  content_rowid='id',
  tokenize='unicode61'
);

-- Keep FTS in sync with rows. We INSERT manually (not via triggers) so we
-- can skip rows that fail to embed — but if a trigger-based mirror is
-- preferred later, swap these out.

CREATE TABLE IF NOT EXISTS vectors (
  row_id  INTEGER PRIMARY KEY REFERENCES rows(id) ON DELETE CASCADE,
  dim     INTEGER NOT NULL,
  vec     BLOB    NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_cursor (
  file       TEXT PRIMARY KEY,
  byte_off   INTEGER NOT NULL,
  line_no    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL
);

-- Cursor for auto-memory .md files (separate ingest path, content
-- changes in place rather than appending). Stores the mtime so we
-- can detect edits and re-index, and the row id so we can delete
-- the previous version without a file scan.
CREATE TABLE IF NOT EXISTS auto_memory_cursor (
  file       TEXT PRIMARY KEY,
  mtime_ms   INTEGER NOT NULL,
  row_id     INTEGER NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// --- Open / close ---------------------------------------------------------

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const D = loadDriver();
  const db = new D(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Foreign keys are off by default in SQLite. The vectors table has
  // ON DELETE CASCADE referencing rows; without this pragma deletes
  // from rows leave orphaned vectors and stale semantic-search hits.
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// --- Indexing primitives --------------------------------------------------

// Decide what to index from a parsed NDJSON entry. Returns null to skip,
// or { text, sessionId } when the row should be stored. agent-out lines
// are short streamed chunks individually, so we index each as-is — the
// caller deduplicates by (file, line_no).
function extractIndexable(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const kind = entry.kind;
  if (kind === 'agent-in' || kind === 'agent-out') {
    const text = (entry.text || '').trim();
    if (!text) return null;
    return { text, sessionId: null };
  }
  if (kind === 'pty-agent-summary') {
    const parts = [];
    if (entry.model) parts.push(`model=${entry.model}`);
    if (entry.permissionMode) parts.push(`mode=${entry.permissionMode}`);
    if (entry.gitBranch) parts.push(`branch=${entry.gitBranch}`);
    if (entry.cwd) parts.push(`cwd=${entry.cwd}`);
    if (entry.sessionId) parts.push(`session=${entry.sessionId}`);
    if (typeof entry.userTurns === 'number') parts.push(`turns=${entry.userTurns}/${entry.assistantTurns || 0}`);
    if (parts.length === 0) return null;
    return { text: parts.join(' '), sessionId: entry.sessionId || null };
  }
  return null;
}

// Insert a single (rows, fts, vectors) tuple. Returns the new row id, or
// null if the row was already present (UNIQUE(file, line_no) collision).
// Embedding failure is non-fatal: the row + FTS still land, the vector is
// just skipped (search degrades to lexical-only for that row).
async function insertRow(db, { file, lineNo, byteOff, ts, pane, kind, sessionId, text }) {
  const insertRow = db.prepare(`
    INSERT OR IGNORE INTO rows (file, line_no, byte_off, ts, pane, kind, session_id, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertRow.run(file, lineNo, byteOff, ts, pane || null, kind, sessionId || null, text);
  if (info.changes === 0) return null;
  const rowId = info.lastInsertRowid;
  db.prepare('INSERT INTO rows_fts(rowid, text) VALUES (?, ?)').run(rowId, text);
  try {
    const vec = await embed(text);
    db.prepare('INSERT OR REPLACE INTO vectors(row_id, dim, vec) VALUES (?, ?, ?)')
      .run(rowId, DIM, vectorToBlob(vec));
  } catch {
    // Embedder unavailable (e.g. first-run network failure). Row is still
    // searchable via FTS; the vector can be backfilled later.
  }
  return rowId;
}

// Delete a row by id from rows + rows_fts + vectors. The vectors table
// cascades automatically; rows_fts is an external-content FTS5 table
// and needs the explicit 'delete' command, not a DELETE statement.
function deleteRow(db, rowId) {
  const existing = db.prepare('SELECT text FROM rows WHERE id = ?').get(rowId);
  if (!existing) return false;
  // FTS5 external-content table: deleting from rows doesn't update the
  // index. The 'delete' command takes the original rowid + text — must
  // come BEFORE the rows DELETE so we can read the original text.
  db.prepare("INSERT INTO rows_fts(rows_fts, rowid, text) VALUES ('delete', ?, ?)")
    .run(rowId, existing.text);
  // Explicit vector delete in addition to the FK cascade. Defensive:
  // older databases predate `PRAGMA foreign_keys = ON` being set in
  // open() and may have orphaned vectors; the redundant DELETE evicts
  // those too.
  db.prepare('DELETE FROM vectors WHERE row_id = ?').run(rowId);
  db.prepare('DELETE FROM rows WHERE id = ?').run(rowId);
  return true;
}

// --- Auto-memory ingestion ----------------------------------------------
// Walk a directory of .md files (the auto-memory store at
// ~/.claude/projects/<encoded-cwd>/memory/) and mirror their bodies
// into the searchable index. Frontmatter is stripped — we only index
// the prose under the closing `---`. Idempotent: each file's mtime
// is tracked in auto_memory_cursor; unchanged files are skipped, edited
// files trigger a delete+reinsert.
//
// Returns { ingested, skipped, stripped } where:
//   ingested: array of { file, frontmatter, bodyChars }
//   skipped:  array of { file, reason }
//   stripped: array of { file, frontmatter } for the one-time audit log
//             (only populated for newly-indexed or re-indexed files;
//             unchanged files don't re-strip).

// Strip YAML frontmatter from a markdown file's text, returning
// { frontmatter, body }. Both fields are strings; either may be empty.
// No YAML parsing — we only need to peel the frontmatter off so the
// body is what gets indexed. Handles LF and CRLF line endings.
function stripFrontmatter(text) {
  const open = /^---\r?\n/;
  const m = text.match(open);
  if (!m) return { frontmatter: '', body: text };
  const start = m[0].length;
  // Look for `\n---` followed by EOL (next char must be \r or \n).
  let close = -1;
  let scan = start;
  while (scan < text.length) {
    const i = text.indexOf('\n---', scan);
    if (i === -1) break;
    const afterDashes = i + 4;
    if (afterDashes >= text.length) { close = i; break; }
    const next = text[afterDashes];
    if (next === '\n' || next === '\r') { close = i; break; }
    scan = afterDashes;
  }
  if (close === -1) return { frontmatter: '', body: text };
  const frontmatter = text.slice(start, close);
  // Skip past the closing `---` and its line terminator(s).
  let after = close + 4;
  if (text[after] === '\r') after += 1;
  if (text[after] === '\n') after += 1;
  return { frontmatter, body: text.slice(after) };
}

async function ingestAutoMemoryDir(db, memoryDir) {
  const result = { ingested: [], skipped: [], stripped: [] };
  let names;
  try { names = fs.readdirSync(memoryDir); }
  catch { return result; }

  const cursorGet = db.prepare('SELECT mtime_ms, row_id FROM auto_memory_cursor WHERE file = ?');
  const cursorUpsert = db.prepare(`
    INSERT INTO auto_memory_cursor(file, mtime_ms, row_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      row_id = excluded.row_id,
      updated_at = excluded.updated_at
  `);

  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    // Skip MEMORY.md — it's a hand-maintained index of pointers to the
    // other files, not content worth searching on its own. Searching it
    // would just return the one-line hooks we already see in every hit.
    if (n === 'MEMORY.md') continue;
    const full = path.join(memoryDir, n);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;

    const mtimeMs = Math.floor(stat.mtimeMs);
    const cursor = cursorGet.get(full);
    if (cursor && cursor.mtime_ms === mtimeMs) {
      result.skipped.push({ file: full, reason: 'unchanged' });
      continue;
    }

    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); }
    catch (err) { result.skipped.push({ file: full, reason: `read failed: ${err.message}` }); continue; }
    const { frontmatter, body } = stripFrontmatter(raw);
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      result.skipped.push({ file: full, reason: 'empty body after frontmatter' });
      continue;
    }

    // Edited file — delete the old row before inserting the new one
    // so search doesn't return both versions.
    if (cursor && cursor.row_id) deleteRow(db, cursor.row_id);

    const newId = await insertRow(db, {
      file: full,
      lineNo: 1,
      byteOff: 0,
      ts: new Date(mtimeMs).toISOString(),
      pane: null,
      kind: 'auto-memory',
      sessionId: null,
      text: trimmedBody,
    });
    if (newId == null) {
      result.skipped.push({ file: full, reason: 'insert returned null' });
      continue;
    }
    cursorUpsert.run(full, mtimeMs, newId, new Date().toISOString());
    result.ingested.push({ file: full, frontmatter, bodyChars: trimmedBody.length });
    result.stripped.push({ file: full, frontmatter });
  }
  return result;
}

// Resolve the auto-memory directory for a given working directory. Claude
// Code stores per-project memory at ~/.claude/projects/<encoded>/memory/
// where <encoded> is the absolute cwd with `:` and path separators
// replaced by `-`. This matches Claude Code's own encoding scheme.
function autoMemoryDirFor(cwd) {
  const home = require('os').homedir();
  const absolute = path.resolve(cwd);
  // Encode: replace drive-letter colon and path separators with `-`.
  const encoded = absolute.replace(/[:\\/]/g, '-');
  return path.join(home, '.claude', 'projects', encoded, 'memory');
}

// Ingest one NDJSON file from its last cursor offset onward. Reads the
// file synchronously — these logs are tens of MB at most and we run this
// at startup or right after a turn, both off the UI thread (main process
// only). Returns count of newly-indexed rows.
async function ingestFile(db, file) {
  const cursor = db.prepare('SELECT byte_off, line_no FROM ingest_cursor WHERE file = ?').get(file);
  const startOff = cursor ? cursor.byte_off : 0;
  let lineNo = cursor ? cursor.line_no : 0;
  let stat;
  try { stat = fs.statSync(file); } catch { return 0; }
  if (stat.size <= startOff) return 0;

  const fd = fs.openSync(file, 'r');
  const len = stat.size - startOff;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, startOff);
  fs.closeSync(fd);

  let inserted = 0;
  let off = startOff;
  let bufOff = 0;
  // NDJSON: each line is one JSON object, terminated by \n. A trailing
  // partial line (no \n yet — file still being written) is kept for the
  // next ingest pass by leaving the cursor before it.
  while (true) {
    const nl = buf.indexOf(0x0a, bufOff);
    if (nl === -1) break;
    const line = buf.slice(bufOff, nl).toString('utf8');
    const lineByteLen = (nl - bufOff) + 1; // include \n
    lineNo += 1;
    const lineByteOff = off;
    off += lineByteLen;
    bufOff = nl + 1;
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const ix = extractIndexable(entry);
    if (!ix) continue;
    const newId = await insertRow(db, {
      file,
      lineNo,
      byteOff: lineByteOff,
      ts: entry.ts || '',
      pane: entry.pane || null,
      kind: entry.kind,
      sessionId: ix.sessionId,
      text: ix.text,
    });
    if (newId != null) inserted += 1;
  }

  db.prepare(`
    INSERT INTO ingest_cursor(file, byte_off, line_no, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file) DO UPDATE SET byte_off=excluded.byte_off, line_no=excluded.line_no, updated_at=excluded.updated_at
  `).run(file, off, lineNo, new Date().toISOString());

  return inserted;
}

// Store a freeform memory directly into the index, bypassing the NDJSON
// ingest path. Used by external agents (Claude CLI, future coding agents)
// that want to record something without going through a session log.
//
// Layout: synthetic file path "<memory:source>" so memories show up
// distinctly in search results and don't collide with real NDJSON files.
// line_no auto-increments per source — UNIQUE(file, line_no) keeps the
// row table happy and makes each memory addressable for later deletion.
async function storeMemory(db, { text, source = 'external', tags = null, ts = null }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('storeMemory: empty text');
  const file = `<memory:${source}>`;
  const stamp = ts || new Date().toISOString();
  const row = db.prepare('SELECT MAX(line_no) AS m FROM rows WHERE file = ?').get(file);
  const lineNo = (row && row.m ? row.m : 0) + 1;
  // Tags ride along inside the indexed text so FTS picks them up. Cheap
  // and avoids a schema change for the MVP.
  const indexed = tags && tags.length ? `${trimmed}\n[tags: ${tags.join(', ')}]` : trimmed;
  const id = await insertRow(db, {
    file,
    lineNo,
    byteOff: 0,
    ts: stamp,
    pane: null,
    kind: 'memory',
    sessionId: null,
    text: indexed,
  });
  return { id, file, lineNo, ts: stamp };
}

// Walk the sessions dir and ingest every *.ndjson incrementally. Idempotent.
async function ingestDir(db, sessionsDir) {
  let names;
  try { names = fs.readdirSync(sessionsDir); } catch { return 0; }
  let total = 0;
  for (const n of names) {
    if (!n.endsWith('.ndjson')) continue;
    const full = path.join(sessionsDir, n);
    total += await ingestFile(db, full);
  }
  return total;
}

// --- Search ---------------------------------------------------------------

// FTS5 query strings need quoting if they contain operators / punctuation.
// We're lenient: drop characters FTS treats as syntax and quote the rest.
function ftsQuote(query) {
  const cleaned = String(query).replace(/["()*:^]/g, ' ').trim();
  if (!cleaned) return '""';
  // Token-level: split, drop empties, requote each token (prefix-match the
  // last so partial words still hit).
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  const last = tokens.pop();
  const quoted = tokens.map((t) => `"${t}"`);
  quoted.push(`"${last}"*`);
  return quoted.join(' ');
}

// Reciprocal-rank fusion: combine two ranked lists of row ids. k=60 is the
// standard RRF constant; small enough that the top of either list still
// dominates, large enough to forgive a low rank on one side when the other
// agrees.
function fuse(lexical, semantic, k = 60) {
  const score = new Map();
  lexical.forEach((id, i) => {
    score.set(id, (score.get(id) || 0) + 1 / (k + i + 1));
  });
  semantic.forEach((id, i) => {
    score.set(id, (score.get(id) || 0) + 1 / (k + i + 1));
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => ({ id, score: s }));
}

// Hybrid search. Returns hits ordered by RRF score (best first), with
// raw cosine + bm25 captured per hit and a computed `confidence`
// number for thresholding/UI display.
//
// Strategy:
//   - FTS pass returns top N by BM25 ascending (lower = better)
//   - Semantic pass returns top N by cosine descending (higher = better)
//   - Fuse via RRF (rank-based)
//   - For each fused hit: capture raw cosine + raw bm25, then compute
//     `confidence = max(cosine_norm, bm25_norm)` where
//        cosine_norm = max(0, cosine)
//        bm25_norm   = ftsMatched ? bestBm25 / rowBm25 : 0   (per-query)
//     See docs/memory-search.md for the full design rationale.
//
// Options:
//   limit:          max hits returned (default 10). With minConfidence
//                   set, the candidate cap relaxes so we can return
//                   every qualifying row.
//   minConfidence:  filter; default 0 (no filter). When > 0 and limit
//                   is not explicitly set, returns ALL rows ≥ threshold.
//   kindFilter:     filter to one row kind.
async function search(db, query, opts = {}) {
  const { kindFilter = null, minConfidence = 0 } = opts;
  const limitProvided = typeof opts.limit === 'number';
  const limit = limitProvided ? opts.limit : 10;

  // When the caller provides a minConfidence and no explicit limit,
  // relax the candidate pool so we can scan the full index. Otherwise
  // 4×limit is plenty of fusion headroom.
  const N = (minConfidence > 0 && !limitProvided)
    ? Number.MAX_SAFE_INTEGER
    : Math.max(limit * 4, 20);

  const kindClause = kindFilter ? `AND r.kind = '${kindFilter.replace(/'/g, "''")}'` : '';

  // Lexical: FTS5 ordered by bm25 ascending (lower == more relevant).
  // Capture raw bm25 alongside the row id so we can compute bm25_norm.
  const ftsQ = ftsQuote(query);
  const lexicalScored = db.prepare(`
    SELECT r.id AS id, bm25(rows_fts) AS bm25
    FROM rows_fts f
    JOIN rows r ON r.id = f.rowid
    WHERE f.text MATCH ? ${kindClause}
    ORDER BY bm25 ASC
    LIMIT ?
  `).all(ftsQ, N === Number.MAX_SAFE_INTEGER ? -1 : N);
  const lexicalRows = lexicalScored.map((r) => r.id);
  const bm25ById = new Map(lexicalScored.map((r) => [r.id, r.bm25]));
  // best_bm25 is the most-negative number (best FTS match for this query).
  const bestBm25 = lexicalScored.length > 0
    ? Math.min(...lexicalScored.map((r) => r.bm25))
    : null;

  // Semantic: embed the query, scan vectors, take top N by cosine.
  // Capture raw cosine per row.
  let semanticRows = [];
  const cosineById = new Map();
  try {
    const qVec = await embed(query);
    const scan = db.prepare(`
      SELECT v.row_id AS id, v.vec AS vec
      FROM vectors v
      JOIN rows r ON r.id = v.row_id
      WHERE 1=1 ${kindClause}
    `).all();
    const scored = [];
    for (const row of scan) {
      const v = blobToVector(row.vec);
      if (v.length !== qVec.length) continue;
      const c = cosine(qVec, v);
      scored.push({ id: row.id, score: c });
      cosineById.set(row.id, c);
    }
    scored.sort((a, b) => b.score - a.score);
    const take = N === Number.MAX_SAFE_INTEGER ? scored.length : N;
    semanticRows = scored.slice(0, take).map((r) => r.id);
  } catch {
    // Embedder unavailable — fall back to lexical only.
  }

  let fused = fuse(lexicalRows, semanticRows);
  if (fused.length === 0) return [];

  // Annotate every fused hit with raw signals + computed confidence.
  // Computing confidence happens before any limiting/filtering so the
  // threshold check is on the real value.
  const annotated = fused.map((f) => {
    const cosineRaw = cosineById.has(f.id) ? cosineById.get(f.id) : null;
    const bm25Raw = bm25ById.has(f.id) ? bm25ById.get(f.id) : null;
    const cosineNorm = Math.max(0, cosineRaw == null ? 0 : cosineRaw);
    // Per-query BM25 normalization. Both numbers are negative; the
    // best row has the most-negative bm25 (largest magnitude). To
    // produce a [0, 1] ratio where the best row gets 1.0:
    //   bm25Norm = rowBm25 / bestBm25
    //              = less_negative / more_negative
    //              = positive in [0, 1]
    // Best row: bestBm25 / bestBm25 = 1.0. Weaker rows: smaller ratio.
    // (Inverted formula gives values > 1 — that was a regression.)
    const bm25Norm = (bm25Raw != null && bestBm25 != null && bestBm25 < 0)
      ? bm25Raw / bestBm25
      : 0;
    const confidence = Math.max(cosineNorm, bm25Norm);
    return {
      id: f.id,
      score: f.score,
      cosine: cosineRaw,
      bm25: bm25Raw,
      confidence,
    };
  });

  // Apply minConfidence filter, then limit. Track how many candidates
  // existed before filtering so the UI can say "X strong, Y hidden".
  const totalCandidates = annotated.length;
  let filtered = annotated;
  if (minConfidence > 0) {
    filtered = annotated.filter((h) => h.confidence >= minConfidence);
  }
  if (limitProvided || minConfidence === 0) {
    filtered = filtered.slice(0, limit);
  }
  if (filtered.length === 0) {
    // Return the array shape AND attach metadata for callers that
    // want it. Backwards-compatible: array methods all still work.
    const empty = [];
    Object.defineProperty(empty, 'totalCandidates', { value: totalCandidates, enumerable: false });
    return empty;
  }

  // Hydrate row text/metadata in one round-trip.
  const ids = filtered.map((f) => f.id);
  const placeholders = ids.map(() => '?').join(',');
  const hydrated = db.prepare(`
    SELECT id, file, line_no, byte_off, ts, pane, kind, session_id, text
    FROM rows WHERE id IN (${placeholders})
  `).all(...ids);
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  const result = filtered
    .map((f) => {
      const r = byId.get(f.id);
      if (!r) return null;
      return {
        id: r.id,
        score: f.score,
        cosine: f.cosine,
        bm25: f.bm25,
        confidence: f.confidence,
        file: r.file,
        lineNo: r.line_no,
        byteOff: r.byte_off,
        ts: r.ts,
        pane: r.pane,
        kind: r.kind,
        sessionId: r.session_id,
        // Full row content (no truncation) — for callers that need to
        // operate on the entire memory (e.g. inserting into compose).
        text: r.text,
        // Truncated preview — for compact UI display.
        snippet: r.text.length > 400 ? r.text.slice(0, 400) + '…' : r.text,
      };
    })
    .filter(Boolean);
  // Attach total candidate count (pre-filter) so UI can report
  // "X strong matches, Y hidden". Non-enumerable so JSON.stringify and
  // existing callers ignore it cleanly.
  Object.defineProperty(result, 'totalCandidates', {
    value: totalCandidates, enumerable: false,
  });
  return result;
}

// --- Stats (handy for debugging from DevTools) ----------------------------

function stats(db) {
  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM rows').get().c;
  const vecCount = db.prepare('SELECT COUNT(*) AS c FROM vectors').get().c;
  const fileCount = db.prepare('SELECT COUNT(*) AS c FROM ingest_cursor').get().c;
  return { rows: rowCount, vectors: vecCount, files: fileCount };
}

module.exports = {
  open,
  ingestFile,
  ingestDir,
  ingestAutoMemoryDir,
  autoMemoryDirFor,
  storeMemory,
  search,
  stats,
  // exported for tests
  extractIndexable,
  ftsQuote,
  fuse,
  stripFrontmatter,
};
