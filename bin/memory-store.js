#!/usr/bin/env node
// CLI shim that writes a freeform memory into the MyAgent index. Mirror
// of bin/memory-search.js — talks to the running Electron app's loopback
// server when available, falls back to opening the SQLite DB locally
// when not.
//
// Usage:
//   node bin/memory-store.js "user prefers tabs over spaces"
//   node bin/memory-store.js --source claude --tags pref,style "..."
//   echo "..." | node bin/memory-store.js --source hook
//
// Output: JSON to stdout. Errors go to stderr.

const fs = require('fs');
const path = require('path');
const sessionClient = require('../src/core/sessionClient');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(PROJECT_ROOT, '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');

function parseArgs(argv) {
  const out = { source: 'cli', tags: null, text: null, forceLocal: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' || a === '-s') out.source = argv[++i] || 'cli';
    else if (a === '--tags' || a === '-t') out.tags = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--local') out.forceLocal = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  out.text = rest.join(' ').trim() || null;
  return out;
}

function printHelp() {
  process.stderr.write([
    'memory-store — write a memory into the MyAgent index',
    '',
    'Usage: node bin/memory-store.js [options] <text>',
    '       echo "<text>" | node bin/memory-store.js [options]',
    '',
    'Options:',
    '  -s, --source NAME    label the source (default: cli)',
    '  -t, --tags a,b,c     comma-separated tags',
    '      --local          skip the running Electron app server',
    '  -h, --help           show this help',
    '',
  ].join('\n') + '\n');
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text) {
    const stdin = (await readStdin()).trim();
    if (stdin) args.text = stdin;
  }
  if (!args.text) {
    process.stderr.write('error: no text provided (pass as args or pipe via stdin)\n');
    process.exit(2);
  }

  const body = { text: args.text, source: args.source, tags: args.tags };

  if (!args.forceLocal) {
    const remote = await sessionClient.tryConnect(SESSIONS_DIR);
    if (remote) {
      try {
        const r = await remote.storeMemory(body);
        process.stdout.write(JSON.stringify(r) + '\n');
        return;
      } catch (err) {
        process.stderr.write(`memory-store: server error, falling back to local — ${err.message}\n`);
      }
    }
  }

  // Standalone fallback. Pays the embedder model load on every call.
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const sessionIndex = require('../src/core/sessionIndex');
  const db = sessionIndex.open(INDEX_DB_PATH);
  const r = await sessionIndex.storeMemory(db, body);
  process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`memory-store failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
