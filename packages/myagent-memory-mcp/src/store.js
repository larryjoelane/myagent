// Append-only JSONL store + in-memory BM25 index.
//
// Why this shape:
//   - Zero native deps. No SQLite, no embedder. Plain Node + fs.
//   - Crash-safe writes: append a line, fsync optional. Loss window is
//     at most one entry on power loss.
//   - Index is rebuilt on startup by replaying the file. Cheap up to
//     tens of thousands of entries; if you outgrow this, swap in
//     SQLite/FTS5 — the on-disk format is human-readable so migration
//     is just a script.
//
// Storage location:
//   $MYAGENT_MEMORY_DIR or ~/.myagent-memory/
//     memory.jsonl                  one JSON object per line
//
// Record shape (one per line):
//   { id, ts, text, source?, tags?: string[] }
//
// IDs are monotonic 1..N. Deletes mark a tombstone record:
//   { id, ts, deleted: <targetId> }

const fs = require('fs');
const path = require('path');
const os = require('os');

// ----- Tokenization ------------------------------------------------------
//
// Lowercase, split on non-word, drop very short tokens. Plain ASCII focus —
// good enough for code/notes. No stemming (would need a dep). English
// stopwords list inlined; small enough to be free.

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','of','to','in','on','at',
  'for','with','by','from','as','is','are','was','were','be','been','being',
  'this','that','these','those','it','its','i','you','we','they','he','she',
  'do','does','did','have','has','had','will','would','should','can','could',
  'not','no','so','than','also','just','about','into','out','up','down',
]);

function tokenize(text) {
  if (!text) return [];
  const out = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9_]+/)) {
    if (!raw) continue;
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

// ----- BM25 --------------------------------------------------------------
//
// Standard Okapi BM25. k1 controls term-frequency saturation, b controls
// length normalization. Defaults are the literature-standard values.

const K1 = 1.5;
const B = 0.75;

function bm25Score({ docTokens, queryTokens, idf, avgDocLen }) {
  // docTokens: token-frequency map for the document
  // queryTokens: deduped query tokens
  // idf: term -> idf score
  let score = 0;
  const docLen = Object.values(docTokens).reduce((a, b) => a + b, 0);
  if (docLen === 0) return 0;
  for (const term of queryTokens) {
    const tf = docTokens[term];
    if (!tf) continue;
    const w = idf[term];
    if (!w) continue;
    const num = tf * (K1 + 1);
    const den = tf + K1 * (1 - B + B * (docLen / avgDocLen));
    score += w * (num / den);
  }
  return score;
}

// ----- Store -------------------------------------------------------------

class MemoryStore {
  constructor({ dir } = {}) {
    this.dir = dir || defaultDir();
    this.file = path.join(this.dir, 'memory.jsonl');
    this.records = [];           // live records, in insertion order
    this.byId = new Map();       // id -> record
    this.tokenized = new Map();  // id -> token-frequency map
    this.docFreq = new Map();    // term -> number of docs containing it
    this.totalLen = 0;           // sum of doc lengths (for avg)
    this.nextId = 1;
    this._loaded = false;
  }

  // Load the JSONL file into memory and build the inverted index.
  // Idempotent — calling load() twice is a no-op after the first.
  load() {
    if (this._loaded) return;
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this._loaded = true;
      return;
    }
    const data = fs.readFileSync(this.file, 'utf8');
    const tombstoned = new Set();
    const buffer = [];
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.deleted) {
        tombstoned.add(rec.deleted);
        continue;
      }
      buffer.push(rec);
      if (typeof rec.id === 'number' && rec.id >= this.nextId) {
        this.nextId = rec.id + 1;
      }
    }
    for (const rec of buffer) {
      if (tombstoned.has(rec.id)) continue;
      this._indexRecord(rec);
    }
    this._loaded = true;
  }

  _indexRecord(rec) {
    this.records.push(rec);
    this.byId.set(rec.id, rec);
    const tokens = tokenize(rec.text);
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    this.tokenized.set(rec.id, tf);
    this.totalLen += tokens.length;
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
    }
  }

  _unindexRecord(id) {
    const rec = this.byId.get(id);
    if (!rec) return;
    const tf = this.tokenized.get(id) || {};
    for (const [term, count] of Object.entries(tf)) {
      this.totalLen -= count;
      const df = this.docFreq.get(term) || 0;
      if (df <= 1) this.docFreq.delete(term);
      else this.docFreq.set(term, df - 1);
    }
    this.tokenized.delete(id);
    this.byId.delete(id);
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx >= 0) this.records.splice(idx, 1);
  }

  // ---- Public API ----

  store({ text, source, tags } = {}) {
    this.load();
    if (!text || typeof text !== 'string') {
      throw new Error('store: text is required');
    }
    const rec = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      text: text.trim(),
    };
    if (source) rec.source = String(source);
    if (Array.isArray(tags) && tags.length) rec.tags = tags.map(String);
    this._append(rec);
    this._indexRecord(rec);
    return { id: rec.id, ts: rec.ts };
  }

  delete(id) {
    this.load();
    const numId = Number(id);
    if (!this.byId.has(numId)) return { ok: false, error: `no record ${numId}` };
    this._append({ id: this.nextId++, ts: new Date().toISOString(), deleted: numId });
    this._unindexRecord(numId);
    return { ok: true };
  }

  list({ limit = 50, source, tag } = {}) {
    this.load();
    let out = this.records;
    if (source) out = out.filter((r) => r.source === source);
    if (tag) out = out.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
    // Most recent first.
    out = out.slice().reverse().slice(0, Math.max(0, limit));
    return out;
  }

  // BM25 search. Returns up to `limit` hits, each with { id, score, text,
  // ts, source, tags, snippet }. `minScore` lets callers reject weak hits.
  search({ query, limit = 10, minScore = 0 } = {}) {
    this.load();
    const q = tokenize(query);
    if (q.length === 0) return [];
    // Dedupe query tokens but keep order.
    const seen = new Set();
    const queryTokens = [];
    for (const t of q) {
      if (seen.has(t)) continue;
      seen.add(t);
      queryTokens.push(t);
    }
    const N = this.records.length;
    if (N === 0) return [];
    const avgDocLen = this.totalLen / N || 1;
    // Precompute IDF per query term. Standard BM25+ smoothing: log(1 + (N-df+0.5)/(df+0.5)).
    const idf = Object.create(null);
    for (const term of queryTokens) {
      const df = this.docFreq.get(term) || 0;
      idf[term] = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    }
    // Candidate set = docs containing at least one query term. Walk only
    // those, not every doc — keeps search ~O(matched docs) not O(corpus).
    const candidates = new Set();
    for (const term of queryTokens) {
      // Reverse-lookup is O(corpus) without a posting list; for the
      // expected scale this is fine. If perf matters later, build a
      // term -> [docIds] inverted list at index time.
      for (const [id, tf] of this.tokenized) {
        if (tf[term]) candidates.add(id);
      }
    }
    const scored = [];
    for (const id of candidates) {
      const docTokens = this.tokenized.get(id);
      const score = bm25Score({ docTokens, queryTokens, idf, avgDocLen });
      if (score <= minScore) continue;
      const rec = this.byId.get(id);
      scored.push({
        id: rec.id,
        score,
        ts: rec.ts,
        text: rec.text,
        source: rec.source,
        tags: rec.tags,
        snippet: makeSnippet(rec.text, queryTokens),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit));
  }

  stats() {
    this.load();
    return {
      records: this.records.length,
      uniqueTerms: this.docFreq.size,
      totalTokens: this.totalLen,
      file: this.file,
    };
  }

  // ---- Internal ----

  _append(rec) {
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }
}

// Build a short snippet by finding the first match of any query term and
// returning ~140 chars of context around it. No regex highlighting — keep
// the output JSON-safe for IPC.
function makeSnippet(text, queryTokens) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const t of queryTokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx < 0) return text.slice(0, 200);
  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(text.length, bestIdx + 140);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function defaultDir() {
  if (process.env.MYAGENT_MEMORY_DIR) return process.env.MYAGENT_MEMORY_DIR;
  return path.join(os.homedir(), '.myagent-memory');
}

module.exports = { MemoryStore, tokenize, defaultDir };
