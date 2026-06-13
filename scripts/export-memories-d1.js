// export-memories-d1.js — export the plasticity graph from a local index.db
// into a Cloudflare D1 seed file (seed.sql).
//
// Emits ONLY the three tables the memory viewer needs:
//   MySecondBrain (turns), msb_neuron (vitality), msb_edge (synapses).
// It deliberately SKIPS the FTS5 virtual table and the *_vectors BLOB tables:
//   • D1 has no FTS5, and
//   • the graph (graphSnapshot) needs neither — it reads only these three.
//
// The output is D1-compatible SQL: plain CREATE TABLE IF NOT EXISTS, a DELETE
// to make re-seeding idempotent, and chunked multi-row INSERTs (D1 caps the
// number of bound params / statement size, so we batch).
//
// Run (self-re-execs under Electron-as-Node for better-sqlite3):
//   npm run export:d1 -- <path/to/index.db> [out.sql]
//   node scripts/export-memories-d1.js <path/to/index.db> [out.sql]
// Then, on the Cloudflare side:
//   wrangler d1 execute <DB_NAME> --file=seed.sql            (local)
//   wrangler d1 execute <DB_NAME> --file=seed.sql --remote   (deployed)

const path = require('path');

// ── Self-re-exec under Electron-as-Node (before requiring native modules) ──
const RUNNING_UNDER_ELECTRON =
  process.env.ELECTRON_RUN_AS_NODE === '1' || Boolean(process.versions.electron);
if (!RUNNING_UNDER_ELECTRON) {
  let electronBin;
  try { electronBin = require('electron'); }
  catch (err) {
    process.stderr.write(`export-memories-d1: cannot find Electron — run \`npm install\`.\n  ${err.message}\n`);
    process.exit(1);
  }
  const child = require('child_process').spawnSync(
    electronBin, [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MYAGENT_QUIET: '1' } },
  );
  process.exit(child.status == null ? 1 : child.status);
}

// ── Under Electron-as-Node now; native modules are safe. ──
const fs = require('fs');
const sessionIndex = require('../src/core/sessionIndex');

const ROWS_PER_INSERT = 50; // batch size — keeps each INSERT well under D1 limits

// D1-compatible schema for the three viewer tables (mirrors sessionIndex SCHEMA,
// minus the FTS/vector tables). Kept here so the seed is self-contained.
const D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS MySecondBrain (
  id              INTEGER PRIMARY KEY,
  prompt          TEXT NOT NULL,
  answer          TEXT,
  worker_id       TEXT,
  provider        TEXT,
  model           TEXT,
  conversation_id TEXT,
  ts              TEXT NOT NULL,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost            REAL
);
CREATE INDEX IF NOT EXISTS msb_ts ON MySecondBrain(ts);

CREATE TABLE IF NOT EXISTS msb_neuron (
  turn_id           INTEGER PRIMARY KEY,
  retrieval_count   INTEGER NOT NULL DEFAULT 0,
  last_retrieved_ts TEXT
);

CREATE TABLE IF NOT EXISTS msb_edge (
  turn_a INTEGER NOT NULL,
  turn_b INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_a, turn_b)
);
CREATE INDEX IF NOT EXISTS msb_edge_b ON msb_edge(turn_b);
`.trim();

// SQL literal for a value: NULL, number, or single-quote-escaped string.
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`; // double single-quotes (SQL standard)
}

// Build chunked multi-row INSERTs for one table.
function insertStatements(table, columns, rows) {
  if (rows.length === 0) return `-- (no rows for ${table})\n`;
  const colList = columns.join(', ');
  const out = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const values = chunk
      .map((r) => `(${columns.map((c) => lit(r[c])).join(', ')})`)
      .join(',\n  ');
    out.push(`INSERT INTO ${table} (${colList}) VALUES\n  ${values};`);
  }
  return out.join('\n');
}

function main() {
  const dbPath = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!dbPath) {
    process.stderr.write('usage: export:d1 -- <path/to/index.db> [out.sql]\n');
    process.exit(2);
  }
  const outArgs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const outPath = outArgs[1] || path.join(process.cwd(), 'seed.sql');

  const db = sessionIndex.open(path.resolve(dbPath));

  // Read the three tables verbatim. (graphSnapshot derives energy at query
  // time, so we export the RAW neuron/edge state — energy is recomputed in the
  // Worker, keeping decay live rather than freezing it at export.)
  const turns = db.prepare(`
    SELECT id, prompt, answer, worker_id, provider, model, conversation_id, ts, tokens_in, tokens_out, cost
    FROM MySecondBrain ORDER BY id
  `).all();
  const neurons = db.prepare(`
    SELECT turn_id, retrieval_count, last_retrieved_ts FROM msb_neuron ORDER BY turn_id
  `).all();
  const edges = db.prepare(`
    SELECT turn_a, turn_b, weight FROM msb_edge ORDER BY turn_a, turn_b
  `).all();
  db.close();

  const sql = [
    '-- Memory plasticity graph export for Cloudflare D1.',
    `-- Source: ${path.resolve(dbPath)}`,
    `-- Turns: ${turns.length} · Neurons: ${neurons.length} · Edges: ${edges.length}`,
    '-- Re-runnable: schema is IF NOT EXISTS; DELETEs clear before re-insert.',
    '',
    D1_SCHEMA,
    '',
    '-- Idempotent reseed: clear existing rows (children first for clarity).',
    'DELETE FROM msb_edge;',
    'DELETE FROM msb_neuron;',
    'DELETE FROM MySecondBrain;',
    '',
    '-- MySecondBrain (turns)',
    insertStatements('MySecondBrain',
      ['id', 'prompt', 'answer', 'worker_id', 'provider', 'model', 'conversation_id', 'ts', 'tokens_in', 'tokens_out', 'cost'],
      turns),
    '',
    '-- msb_neuron (vitality)',
    insertStatements('msb_neuron', ['turn_id', 'retrieval_count', 'last_retrieved_ts'], neurons),
    '',
    '-- msb_edge (synapses)',
    insertStatements('msb_edge', ['turn_a', 'turn_b', 'weight'], edges),
    '',
  ].join('\n');

  fs.writeFileSync(outPath, sql, 'utf8');
  process.stdout.write(
    `Exported ${turns.length} turns, ${neurons.length} neurons, ${edges.length} edges\n`
    + `Wrote ${outPath}\n`
    + `Next: wrangler d1 execute <DB_NAME> --file=${path.basename(outPath)} --remote\n`,
  );
}

main();
