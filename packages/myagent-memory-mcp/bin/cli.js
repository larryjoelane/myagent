#!/usr/bin/env node
// Direct CLI for humans + the Skill wrapper. Mirrors the MCP tools so
// you can use the same store from a shell or a slash-command without
// running the MCP server.
//
// Usage:
//   myagent-memory store "text to remember" [--source X] [--tag t1 --tag t2]
//   myagent-memory search "query" [--limit 5] [--min-score 0]
//   myagent-memory list [--limit 20] [--source X] [--tag t]
//   myagent-memory delete <id>
//   myagent-memory stats
//
// Output is JSON when --json is passed, otherwise human-readable text.

const { MemoryStore } = require('../src/store');

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        // Repeated flags collect into an array (for --tag t1 --tag t2).
        if (key in args.flags) {
          args.flags[key] = [].concat(args.flags[key], [next]);
        } else {
          args.flags[key] = next;
        }
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`myagent-memory — portable memory store

Usage:
  myagent-memory store "text"          [--source X] [--tag t1 [--tag t2 ...]]
  myagent-memory search "query"        [--limit 5] [--min-score 0]
  myagent-memory list                  [--limit 20] [--source X] [--tag t]
  myagent-memory delete <id>
  myagent-memory stats

Flags:
  --json     emit JSON instead of human-readable text
  --dir D    storage directory (overrides MYAGENT_MEMORY_DIR)

Storage location: $MYAGENT_MEMORY_DIR or ~/.myagent-memory/
`);
}

function asArray(v) {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.flags.help || cmd === 'help') {
    printHelp();
    process.exit(cmd ? 0 : 1);
  }

  const store = new MemoryStore({ dir: args.flags.dir });
  const json = !!args.flags.json;
  const out = (obj, text) => {
    if (json) process.stdout.write(JSON.stringify(obj) + '\n');
    else process.stdout.write(text + '\n');
  };

  if (cmd === 'store') {
    const text = args._[1];
    if (!text) { process.stderr.write('store: missing text\n'); process.exit(2); }
    const r = store.store({
      text,
      source: args.flags.source,
      tags: asArray(args.flags.tag),
    });
    out(r, `Saved memory #${r.id} at ${r.ts}.`);
    return;
  }

  if (cmd === 'search') {
    const query = args._[1];
    if (!query) { process.stderr.write('search: missing query\n'); process.exit(2); }
    const limit = args.flags.limit ? Number(args.flags.limit) : 5;
    const minScore = args.flags['min-score'] ? Number(args.flags['min-score']) : 0;
    const hits = store.search({ query, limit, minScore });
    if (json) {
      out({ hits }, '');
      return;
    }
    if (hits.length === 0) { out({ hits: [] }, 'No matches.'); return; }
    const lines = hits.map((h) => {
      const tags = h.tags?.length ? ` [${h.tags.join(', ')}]` : '';
      const src = h.source ? ` (${h.source})` : '';
      return `#${h.id} score=${h.score.toFixed(2)} ${h.ts}${src}${tags}\n  ${h.snippet}`;
    });
    out({ hits }, lines.join('\n\n'));
    return;
  }

  if (cmd === 'list') {
    const limit = args.flags.limit ? Number(args.flags.limit) : 20;
    const recs = store.list({ limit, source: args.flags.source, tag: args.flags.tag });
    if (json) { out({ records: recs }, ''); return; }
    if (recs.length === 0) { out({ records: [] }, 'No memories.'); return; }
    const lines = recs.map((r) => {
      const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';
      const src = r.source ? ` (${r.source})` : '';
      return `#${r.id} ${r.ts}${src}${tags}\n  ${r.text}`;
    });
    out({ records: recs }, lines.join('\n\n'));
    return;
  }

  if (cmd === 'delete') {
    const id = Number(args._[1]);
    if (!id) { process.stderr.write('delete: missing id\n'); process.exit(2); }
    const r = store.delete(id);
    if (!r.ok) {
      if (json) out(r, '');
      else process.stderr.write(r.error + '\n');
      process.exit(1);
    }
    out({ ok: true, id }, `Deleted memory #${id}.`);
    return;
  }

  if (cmd === 'stats') {
    const s = store.stats();
    out(s, `records=${s.records} unique_terms=${s.uniqueTerms} total_tokens=${s.totalTokens}\nfile=${s.file}`);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  printHelp();
  process.exit(2);
}

main();
