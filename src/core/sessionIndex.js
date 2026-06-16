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

// Saturation constant for mapping a raw (negative) BM25 score to an absolute
// [0,1) relevance: bm25Norm = 1 - exp(BM25_K * bm25). Tuned so a strong
// single-term match (bm25 ≈ -5) lands ~0.7 and a weak one (≈ -1) ~0.22.
// Independent of other rows — unlike the old bm25/bestBm25 ratio, which
// pinned the top hit at 1.0 regardless of true relevance.
const BM25_K = 0.25;

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

-- MySecondBrain: one row per chat Q+A TURN (prompt + answer together), so a
-- search hit recalls the whole exchange. Replaces the old two-unlinked-rows
-- chat mirror (user prompt and assistant answer used to be separate rows in
-- the rows table with nothing linking them). prompt/answer are discrete
-- columns; there is no combined search_text column — the FTS table below
-- indexes BOTH columns directly, and the embedding is computed from
-- prompt+answer at write time (transient, not persisted).
CREATE TABLE IF NOT EXISTS MySecondBrain (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt          TEXT    NOT NULL,
  answer          TEXT,
  worker_id       TEXT,
  provider        TEXT,
  model           TEXT,
  conversation_id TEXT,
  ts              TEXT    NOT NULL,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost            REAL
);
CREATE INDEX IF NOT EXISTS msb_ts ON MySecondBrain(ts);
CREATE INDEX IF NOT EXISTS msb_conversation ON MySecondBrain(conversation_id);

-- FTS over BOTH prompt and answer (a query matches either side). External-
-- content table mirrors rows_fts; we keep it in sync with manual INSERTs.
CREATE VIRTUAL TABLE IF NOT EXISTS MySecondBrain_fts USING fts5(
  prompt,
  answer,
  content='MySecondBrain',
  content_rowid='id',
  tokenize='unicode61'
);

-- One embedding per turn (vector of the combined prompt + answer). Mirrors
-- the vectors table; ON DELETE CASCADE keeps it tidy when a turn is removed.
CREATE TABLE IF NOT EXISTS MySecondBrain_vectors (
  turn_id INTEGER PRIMARY KEY REFERENCES MySecondBrain(id) ON DELETE CASCADE,
  dim     INTEGER NOT NULL,
  vec     BLOB    NOT NULL
);

-- ── Neuroplasticity layer (turn-grained) ─────────────────────────────────
-- Treats each turn as a "neuron" whose retrieval RANK is modulated by two
-- biological signals. NOTHING is ever deleted by decay — energy only re-ranks
-- (per the design decision: rank-don't-prune for now).
--
-- msb_neuron: per-turn vitality. retrieval_count + last_retrieved_ts feed an
--   energy() computed at query time as recency × frequency (an Ebbinghaus-style
--   forgetting curve). A turn that's recalled often and recently stays "hot".
CREATE TABLE IF NOT EXISTS msb_neuron (
  turn_id           INTEGER PRIMARY KEY REFERENCES MySecondBrain(id) ON DELETE CASCADE,
  retrieval_count   INTEGER NOT NULL DEFAULT 0,
  last_retrieved_ts TEXT
);

-- msb_edge: Hebbian co-retrieval graph — "neurons that fire together wire
--   together". When one query returns a set of turns, every unordered PAIR
--   among them gets its edge weight incremented. Later, a query that hits one
--   turn spreads a fraction of that hit's score to its wired neighbours
--   (associative recall a plain vector store can't do). Stored undirected by
--   convention turn_a < turn_b so each pair has exactly one row. Both FK ends
--   CASCADE so deleting a turn sweeps its synapses.
CREATE TABLE IF NOT EXISTS msb_edge (
  turn_a INTEGER NOT NULL REFERENCES MySecondBrain(id) ON DELETE CASCADE,
  turn_b INTEGER NOT NULL REFERENCES MySecondBrain(id) ON DELETE CASCADE,
  weight REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_a, turn_b)
);
CREATE INDEX IF NOT EXISTS msb_edge_b ON msb_edge(turn_b);
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
    // ABSOLUTE BM25 normalization. The old formula divided by the best
    // row's bm25, which made the top hit ALWAYS score 1.0 (and a single
    // result trivially 1.0) — a relative ranking, not a relevance signal.
    // That manufactured fake-perfect confidence for any keyword match and
    // made keyword vs. semantic hits incomparable on one threshold.
    //
    // bm25() is ≤ 0 (more negative = better). Map magnitude to [0,1) with a
    // saturating transform that doesn't depend on other rows:
    //   bm25Norm = 1 - exp(BM25_K * bm25Raw)
    // bm25Raw=0 → 0 (no lexical signal); large magnitude → →1. This also
    // self-corrects the small-corpus case: with few docs, IDF collapses and
    // bm25≈0, so bm25Norm≈0 and cosine becomes the honest dominant signal.
    const bm25Norm = (bm25Raw != null && bm25Raw < 0)
      ? 1 - Math.exp(BM25_K * bm25Raw)
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

// --- MySecondBrain: chat Q+A turns ----------------------------------------
// One row per turn (prompt + answer together), hybrid-searchable like the
// `rows` index but keeping the pair linked. The embedding indexes
// prompt + "\n" + answer; the FTS table indexes both columns directly.

// Combined text used for the embedding (FTS indexes the columns separately,
// so this is only for the vector). Kept transient — never persisted.
function turnEmbedText(prompt, answer) {
  return `${String(prompt || '').trim()}\n${String(answer || '').trim()}`.trim();
}

// Store one Q+A turn. Returns the new turn id. Embedding failure is
// non-fatal (the turn still lands + is FTS-searchable). `answer` may be
// empty (an aborted turn) — we still store the prompt.
async function storeTurn(db, {
  prompt, answer = '', workerId = null, provider = null, model = null,
  conversationId = null, ts = null, tokensIn = null, tokensOut = null, cost = null,
} = {}) {
  const p = String(prompt || '').trim();
  const a = String(answer || '').trim();
  if (!p && !a) throw new Error('storeTurn: prompt and answer both empty');
  const stamp = ts || new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO MySecondBrain
      (prompt, answer, worker_id, provider, model, conversation_id, ts, tokens_in, tokens_out, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p, a, workerId, provider, model, conversationId, stamp, tokensIn, tokensOut, cost);
  const turnId = info.lastInsertRowid;
  // FTS5 external-content: insert prompt + answer under the turn's rowid.
  db.prepare('INSERT INTO MySecondBrain_fts(rowid, prompt, answer) VALUES (?, ?, ?)')
    .run(turnId, p, a);
  try {
    const vec = await embed(turnEmbedText(p, a));
    db.prepare('INSERT OR REPLACE INTO MySecondBrain_vectors(turn_id, dim, vec) VALUES (?, ?, ?)')
      .run(turnId, DIM, vectorToBlob(vec));
  } catch {
    // Embedder unavailable — turn is still FTS-searchable; vector backfills later.
  }
  return { id: turnId, ts: stamp };
}

// Delete a turn from MySecondBrain + its FTS entry + vector. (Used by a
// future migration/cleanup; not wired to UI.)
function deleteTurn(db, turnId) {
  const existing = db.prepare('SELECT prompt, answer FROM MySecondBrain WHERE id = ?').get(turnId);
  if (!existing) return false;
  db.prepare("INSERT INTO MySecondBrain_fts(MySecondBrain_fts, rowid, prompt, answer) VALUES ('delete', ?, ?, ?)")
    .run(turnId, existing.prompt, existing.answer);
  db.prepare('DELETE FROM MySecondBrain_vectors WHERE turn_id = ?').run(turnId);
  db.prepare('DELETE FROM MySecondBrain WHERE id = ?').run(turnId);
  return true;
}

// ── Neuroplasticity: better-sqlite3 ADAPTER over plasticityCore ──────────
//
// The energy/firing/spreading/snapshot LOGIC lives in plasticityCore.js (pure,
// driver-agnostic) so the same code runs here on better-sqlite3 AND in the
// Cloudflare Worker on D1. The functions below are thin adapters: they run the
// SQL (sync better-sqlite3 API) and delegate every decision/computation to the
// core. All weighting is a RANKING signal — never filters or deletes.
const plasticity = require('./plasticityCore');
const { DEFAULT_MIN_FIRING_CONFIDENCE, SPREAD_FACTOR, SPREAD_WEIGHT_NORM } = plasticity.TUNABLES;

// Re-export the pure scoring fns under their existing names (callers/tests use
// them directly). They have no DB dependency.
const neuronEnergy = plasticity.neuronEnergy;
const energyMultiplier = plasticity.energyMultiplier;

// Record a "firing": the set of turn ids returned by one query fired together.
// Bumps each neuron's retrieval_count + last_retrieved_ts, and strengthens the
// Hebbian edge for every unordered pair (turn_a < turn_b). One transaction so
// a search either fully records or not at all. Best-effort — never throws into
// the caller (a plasticity write must not break search).
function recordFiring(db, turnIds, nowIso) {
  // Core decides WHICH ids/pairs (combinatorics); this adapter runs the writes.
  const ids = plasticity.firingIds(turnIds);
  if (ids.length === 0) return;
  const pairs = plasticity.firingPairs(turnIds);
  try {
    const bumpNeuron = db.prepare(`
      INSERT INTO msb_neuron (turn_id, retrieval_count, last_retrieved_ts)
      VALUES (?, 1, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        retrieval_count = retrieval_count + 1,
        last_retrieved_ts = excluded.last_retrieved_ts
    `);
    const bumpEdge = db.prepare(`
      INSERT INTO msb_edge (turn_a, turn_b, weight)
      VALUES (?, ?, 1)
      ON CONFLICT(turn_a, turn_b) DO UPDATE SET weight = weight + 1
    `);
    const tx = db.transaction(() => {
      for (const id of ids) bumpNeuron.run(id, nowIso);
      for (const [a, b] of pairs) bumpEdge.run(a, b);
    });
    tx();
  } catch {
    // Plasticity is advisory; a failed write must not fail the search.
  }
}

// Load neuron rows for a set of turn ids → Map(turn_id -> neuron row).
function loadNeurons(db, turnIds) {
  const ids = [...new Set(turnIds.filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return new Map();
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT turn_id, retrieval_count, last_retrieved_ts FROM msb_neuron WHERE turn_id IN (${ph})`,
  ).all(...ids);
  return new Map(rows.map((r) => [r.turn_id, r]));
}

// Spreading activation: given the directly-matched hits (id -> relevance
// score), cascade a fraction of each hit's score to its wired neighbours.
// Returns Map(neighbourId -> boost). Only neighbours NOT among the direct
// hits receive a boost (direct hits already have their own relevance). This
// is what lets a query surface an associatively-linked turn the vector search
// alone would miss.
function spreadingBoost(db, directScoreById, spreadFactor) {
  const ids = [...directScoreById.keys()];
  if (ids.length === 0) return new Map();
  const ph = ids.map(() => '?').join(',');
  // Adapter fetches the edges touching any direct hit; core does the math.
  const edges = db.prepare(`
    SELECT turn_a, turn_b, weight FROM msb_edge
    WHERE turn_a IN (${ph}) OR turn_b IN (${ph})
  `).all(...ids, ...ids);
  return plasticity.computeSpread(edges, directScoreById, spreadFactor);
}

// Export the plasticity graph as a renderer-agnostic snapshot for
// visualization (a standalone Cytoscape viewer today; an in-app panel later).
// Joins turns ← neuron vitality ← synapses, computes energy per node at
// `nowMs`, and returns { nodes, edges, meta }. Pure read — never fires/mutates.
//
// opts:
//   limit          max nodes (default 200), ordered by energy desc so the
//                  most-vital memories are always included
//   minEnergy      drop nodes below this energy (default 0 → keep all)
//   includeIsolated  keep never-fired turns (energy 0.5, no edges)? default true
//   nowMs          clock for energy (default Date.now()) — injectable for tests
//
// node: { id, label, prompt, answer, energy, retrievalCount, lastRetrieved, ts }
// edge: { id, source, target, weight }   (source<target by storage convention)
function graphSnapshot(db, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  // Adapter fetches rows; core assembles the snapshot (same logic D1 will use).
  const turnRows = db.prepare(`
    SELECT t.id, t.prompt, t.answer, t.ts,
           n.retrieval_count AS retrieval_count,
           n.last_retrieved_ts AS last_retrieved_ts
    FROM MySecondBrain t
    LEFT JOIN msb_neuron n ON n.turn_id = t.id
  `).all();
  const edgeRows = db.prepare('SELECT turn_a, turn_b, weight FROM msb_edge').all();
  return plasticity.buildSnapshot(turnRows, edgeRows, { ...opts, nowMs });
}

// Hybrid search over MySecondBrain turns. Same BM25+cosine fusion as
// search() but against the turn table. Returns hits with prompt/answer
// surfaced separately (so the UI can render the pair) plus a combined
// `text` for compatibility with the existing memory-results bubble.
//
// Neuroplasticity (opt-out via opts.plasticity === false): the fused
// relevance is modulated by each turn's energy (recency×frequency) and by
// spreading activation along the Hebbian co-retrieval graph, then the final
// returned set is recorded as a "firing" (strengthening neurons + edges) so
// future queries recall associatively. Ranking only — never filters/deletes.
async function searchTurns(db, query, opts = {}) {
  const { minConfidence = 0 } = opts;
  // Reinforcement floor (see DEFAULT_MIN_FIRING_CONFIDENCE). Independent of the
  // display threshold so weak hits can be shown without being learned.
  const minFiringConfidence = typeof opts.minFiringConfidence === 'number'
    ? opts.minFiringConfidence
    : DEFAULT_MIN_FIRING_CONFIDENCE;
  // "Spread strength" — how much an associatively-wired neighbour is boosted.
  // Undefined → plasticityCore's SPREAD_FACTOR default. UI slider overrides.
  const spreadFactor = typeof opts.spreadFactor === 'number' ? opts.spreadFactor : undefined;
  const limitProvided = typeof opts.limit === 'number';
  const limit = limitProvided ? opts.limit : 10;
  const N = (minConfidence > 0 && !limitProvided)
    ? Number.MAX_SAFE_INTEGER
    : Math.max(limit * 4, 20);

  // Lexical over the two-column FTS. bm25() scores the whole row (both cols).
  const ftsQ = ftsQuote(query);
  const lexicalScored = db.prepare(`
    SELECT f.rowid AS id, bm25(MySecondBrain_fts) AS bm25
    FROM MySecondBrain_fts f
    WHERE MySecondBrain_fts MATCH ?
    ORDER BY bm25 ASC
    LIMIT ?
  `).all(ftsQ, N === Number.MAX_SAFE_INTEGER ? -1 : N);
  const lexicalRows = lexicalScored.map((r) => r.id);
  const bm25ById = new Map(lexicalScored.map((r) => [r.id, r.bm25]));
  const bestBm25 = lexicalScored.length > 0
    ? Math.min(...lexicalScored.map((r) => r.bm25))
    : null;

  // Semantic over the turn vectors.
  let semanticRows = [];
  const cosineById = new Map();
  try {
    const qVec = await embed(query);
    const scan = db.prepare('SELECT turn_id AS id, vec FROM MySecondBrain_vectors').all();
    const scored = [];
    for (const row of scan) {
      const v = blobToVector(row.vec);
      if (v.length !== qVec.length) continue;
      const c = cosine(qVec, v);
      scored.push({ id: row.id, score: c });
      cosineById.set(row.id, c);
    }
    scored.sort((x, y) => y.score - x.score);
    const take = N === Number.MAX_SAFE_INTEGER ? scored.length : N;
    semanticRows = scored.slice(0, take).map((r) => r.id);
  } catch {
    // Embedder unavailable — lexical only.
  }

  const fused = fuse(lexicalRows, semanticRows);
  if (fused.length === 0) {
    const empty = [];
    Object.defineProperty(empty, 'totalCandidates', { value: 0, enumerable: false });
    return empty;
  }

  const annotated = fused.map((f) => {
    const cosineRaw = cosineById.has(f.id) ? cosineById.get(f.id) : null;
    const bm25Raw = bm25ById.has(f.id) ? bm25ById.get(f.id) : null;
    const cosineNorm = Math.max(0, cosineRaw == null ? 0 : cosineRaw);
    // Absolute BM25 → [0,1) relevance (see the long note in search()). The
    // old bm25Raw/bestBm25 made every keyword hit score 1.0 regardless of
    // real relevance, so keyword and semantic hits couldn't share a
    // threshold. This transform is independent of other rows.
    const bm25Norm = (bm25Raw != null && bm25Raw < 0)
      ? 1 - Math.exp(BM25_K * bm25Raw)
      : 0;
    const confidence = Math.max(cosineNorm, bm25Norm);
    return { id: f.id, score: f.score, cosine: cosineRaw, bm25: bm25Raw, confidence };
  });

  // ── Neuroplasticity re-ranking (opt-out via opts.plasticity === false) ──
  // Layer energy (recency×frequency) and spreading activation onto the fused
  // relevance, THEN re-sort, so a hot or associatively-linked turn can climb
  // into the top-`limit`. We do this over the FULL candidate set (before the
  // slice) so spreading can pull a neighbour up from the long tail. Ranking
  // only: confidence (the relevance floor / threshold) is left untouched, so
  // this never resurrects an irrelevant turn past minConfidence.
  const plasticityOn = opts.plasticity !== false;
  if (plasticityOn) {
    const nowMs = Date.now();
    const directScoreById = new Map(annotated.map((a) => [a.id, a.score]));
    const boost = spreadingBoost(db, directScoreById, spreadFactor);
    // Neighbours surfaced purely by spreading (not in the fused set) join the
    // candidate pool with zero base relevance + their boost. They still must
    // clear minConfidence (confidence 0) so they only appear when no threshold
    // is set — associative recall is opt-in via an unfiltered query.
    for (const [neighbourId, add] of boost.entries()) {
      if (!directScoreById.has(neighbourId)) {
        annotated.push({ id: neighbourId, score: 0, cosine: null, bm25: null, confidence: 0 });
      }
    }
    const neurons = loadNeurons(db, annotated.map((a) => a.id));
    for (const a of annotated) {
      const energy = neuronEnergy(neurons.get(a.id), nowMs);
      const spread = boost.get(a.id) || 0;
      a.energy = energy;
      // Final rank = (relevance + associative spread) × energy multiplier.
      a.score = (a.score + spread) * energyMultiplier(energy);
    }
    annotated.sort((x, y) => y.score - x.score);
  }

  const totalCandidates = annotated.length;
  let filtered = annotated;
  if (minConfidence > 0) filtered = annotated.filter((h) => h.confidence >= minConfidence);
  if (limitProvided || minConfidence === 0) filtered = filtered.slice(0, limit);
  if (filtered.length === 0) {
    const empty = [];
    Object.defineProperty(empty, 'totalCandidates', { value: totalCandidates, enumerable: false });
    return empty;
  }

  const ids = filtered.map((f) => f.id);
  const placeholders = ids.map(() => '?').join(',');
  const hydrated = db.prepare(`
    SELECT id, prompt, answer, worker_id, provider, model, conversation_id, ts, tokens_in, tokens_out, cost
    FROM MySecondBrain WHERE id IN (${placeholders})
  `).all(...ids);
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  const result = filtered.map((f) => {
    const r = byId.get(f.id);
    if (!r) return null;
    // Combined text kept for the existing results-bubble (which renders a
    // single `text`/`snippet`); prompt/answer also surfaced for the new
    // collapsed-expand Q+A display.
    const combined = `Q: ${r.prompt}\n\nA: ${r.answer || ''}`.trim();
    return {
      id: r.id,
      score: f.score,
      cosine: f.cosine,
      bm25: f.bm25,
      confidence: f.confidence,
      energy: typeof f.energy === 'number' ? f.energy : null,
      ts: r.ts,
      kind: 'turn',
      prompt: r.prompt,
      answer: r.answer || '',
      workerId: r.worker_id,
      provider: r.provider,
      model: r.model,
      conversationId: r.conversation_id,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      text: combined,
      snippet: combined.length > 400 ? combined.slice(0, 400) + '…' : combined,
    };
  }).filter(Boolean);

  // Record the firing: the turns we actually return fired together for this
  // query → strengthen their neurons + Hebbian edges so future queries recall
  // them faster and surface their associations. After hydration so we only
  // reinforce turns that truly exist. Best-effort; never throws.
  //
  // ONLY turns clearing minFiringConfidence are fired — so a weak hit shown in
  // an unfiltered query (minConfidence 0) is NOT learned. This is the guard for
  // the "garbage amplified" pollution: an off-topic turn that merely rode along
  // in the top-k never gets wired in. Display set (result) and firing set are
  // intentionally different.
  if (plasticityOn) {
    // Core picks which hits clear the reinforcement floor (same logic D1 uses).
    const targets = plasticity.firingTargets(result, minFiringConfidence);
    if (targets.length > 0) {
      recordFiring(db, targets, new Date().toISOString());
    }
  }

  Object.defineProperty(result, 'totalCandidates', { value: totalCandidates, enumerable: false });
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
  // MySecondBrain (chat Q+A turns)
  storeTurn,
  deleteTurn,
  searchTurns,
  // Neuroplasticity layer (exported for tests + future tools/UI)
  recordFiring,
  loadNeurons,
  neuronEnergy,
  energyMultiplier,
  spreadingBoost,
  graphSnapshot,
  // exported for tests
  extractIndexable,
  ftsQuote,
  fuse,
  stripFrontmatter,
};
