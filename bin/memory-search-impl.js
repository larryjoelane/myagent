#!/usr/bin/env node
// memory-search implementation. Invoked by bin/memory-search.js, which
// re-execs us under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1)
// so we share the same better-sqlite3 ABI as the running app — no
// more rebuild ping-pong between Node and Electron.
//
// Output: JSON to stdout. Errors and progress notes go to stderr so the
// stdout stream is always machine-parseable.

const fs = require('fs');
const path = require('path');
const sessionClient = require('../src/core/sessionClient');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// Honor MYAGENT_SESSIONS_DIR so tests + alternate-profile setups can
// point at a separate index. Matches electron/main.js:47 — same env
// var, same fallback. Without this, e2e tests that pre-populate a
// temp sessions dir for the running app would not be visible to this
// CLI, which is what the e2e harness uses to verify memory mirroring.
const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(PROJECT_ROOT, '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');

// Lazy-required so a CLI run that goes entirely through the running
// Electron app's HTTP server never even loads better-sqlite3 or the
// embedder — that's the whole point of the server path.
let _sessionIndex = null;
function loadSessionIndex() {
  if (!_sessionIndex) _sessionIndex = require('../src/core/sessionIndex');
  return _sessionIndex;
}

function parseArgs(argv) {
  const out = {
    query: null, limit: 10, kindFilter: null,
    ingest: false, stats: false,
    forceLocal: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '-n') out.limit = Number(argv[++i]) || 10;
    else if (a === '--kind' || a === '-k') out.kindFilter = argv[++i] || null;
    else if (a === '--ingest') out.ingest = true;
    else if (a === '--stats') out.stats = true;
    else if (a === '--local') out.forceLocal = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  out.query = rest.join(' ').trim() || null;
  return out;
}

function printHelp() {
  process.stderr.write([
    'memory-search — query the MyAgent session index',
    '',
    'Usage: node bin/memory-search.js [options] <query>',
    '',
    'Options:',
    '  -n, --limit N        max hits to return (default 10)',
    '  -k, --kind KIND      filter to one row kind (agent-in | agent-out | pty-agent-summary | auto-memory | memory)',
    '      --ingest         re-scan NDJSON logs + auto-memory and exit',
    '      --stats          print index stats and exit',
    '      --local          skip the running Electron app server, search in-process',
    '  -h, --help           show this help',
    '',
  ].join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(SESSIONS_DIR)) {
    // Empty index is a valid state — print empty result rather than error
    // so callers (the skill, the slash command) don't have to special-case
    // a fresh checkout.
    process.stdout.write(JSON.stringify({ hits: [], stats: { rows: 0, vectors: 0, files: 0 } }) + '\n');
    return;
  }

  // Fast path: if the Electron app is running, route through its loopback
  // server. The model is already loaded there, so we skip the ~3s cold
  // start we'd otherwise pay for every CLI invocation.
  if (!args.forceLocal) {
    const remote = await sessionClient.tryConnect(SESSIONS_DIR);
    if (remote) {
      try {
        if (args.stats) {
          const s = await remote.stats();
          process.stdout.write(JSON.stringify(s) + '\n');
          return;
        }
        if (args.ingest) {
          const r = await remote.ingest();
          process.stdout.write(JSON.stringify(r) + '\n');
          return;
        }
        if (!args.query) {
          process.stderr.write('error: missing query (use --help)\n');
          process.exit(2);
        }
        const result = await remote.search(args.query, {
          limit: args.limit,
          kindFilter: args.kindFilter,
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      } catch (err) {
        // Server replied badly — fall through to local. Log to stderr so
        // a debugging human sees why; stdout stays JSON-clean.
        process.stderr.write(`memory-search: server error, falling back to local — ${err.message}\n`);
      }
    }
  }

  // Standalone fallback: open the DB in-process and embed locally. Pays
  // the model-load cost on every call.
  const sessionIndex = loadSessionIndex();
  const db = sessionIndex.open(INDEX_DB_PATH);
  await sessionIndex.ingestDir(db, SESSIONS_DIR);

  // Auto-memory ingest: walk ~/.claude/projects/<encoded-cwd>/memory/
  // and mirror each .md body (frontmatter stripped) into the index.
  // Searched against `cwd` so this only walks the auto-memory for the
  // project we're sitting in. Idempotent via mtime.
  const autoMemoryDir = sessionIndex.autoMemoryDirFor(process.cwd());
  const autoMemoryResult = await sessionIndex.ingestAutoMemoryDir(db, autoMemoryDir);
  if (args.ingest && autoMemoryResult.stripped.length > 0) {
    // One-time audit of what frontmatter got stripped during this run.
    // Only fires when --ingest is the requested action so search runs
    // stay quiet. Goes to stderr so the JSON on stdout is unaffected.
    process.stderr.write(`auto-memory: ingested ${autoMemoryResult.ingested.length} file(s) from ${autoMemoryDir}\n`);
    for (const s of autoMemoryResult.stripped) {
      const fm = s.frontmatter.trim();
      process.stderr.write(`--- stripped frontmatter from ${path.basename(s.file)}:\n`);
      process.stderr.write(fm.split('\n').map((l) => `    ${l}`).join('\n') + '\n');
    }
  }

  if (args.ingest) {
    process.stdout.write(JSON.stringify({
      ok: true,
      stats: sessionIndex.stats(db),
      autoMemory: {
        dir: autoMemoryDir,
        ingested: autoMemoryResult.ingested.length,
        skipped: autoMemoryResult.skipped.length,
      },
    }) + '\n');
    return;
  }
  if (args.stats) {
    process.stdout.write(JSON.stringify(sessionIndex.stats(db)) + '\n');
    return;
  }
  if (!args.query) {
    process.stderr.write('error: missing query (use --help)\n');
    process.exit(2);
  }

  const hits = await sessionIndex.search(db, args.query, {
    limit: args.limit,
    kindFilter: args.kindFilter,
  });
  process.stdout.write(JSON.stringify({ hits, stats: sessionIndex.stats(db) }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`memory-search failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
