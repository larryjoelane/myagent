// Memory Search — wraps the project's session-log search index so the
// semantic agent can recall prior conversations.
//
// Built as a *factory* (createMemorySearchTool) rather than a static
// object because it needs a search function injected at construction
// time. The default factory looks for an indexHost (the WorkerHost
// from sessionWorkerHost.js) and uses its .search() method.
//
// This keeps the tool reusable in tests — pass a fake `search` and you
// don't need a real SQLite index.

// Per-hit body cap. Generous so substantive memories (formulas, code
// snippets, multi-paragraph explanations) survive intact. The actual
// indexed `text` field can be larger than this, but rendering the
// full thing for every hit would dominate the chat. Override with
// `--full` (unbounded) or `--cap N` in the user's prompt.
const DEFAULT_BODY_CAP = 2000;

// Pull options out of the user's prompt. We strip them from the
// query so the search itself sees only the search terms.
function parseOptions(input) {
  let q = String(input || '');
  let cap = DEFAULT_BODY_CAP;
  let limit = null;
  let full = false;

  // --full
  if (/(^|\s)--full(\s|$)/.test(q)) { full = true; q = q.replace(/(^|\s)--full(\s|$)/g, ' '); }
  // --cap N (drop body cap to N, or 0 = unlimited)
  q = q.replace(/(^|\s)--cap\s+(\d+)(\s|$)/g, (_m, _a, n, _b) => {
    cap = Math.max(0, parseInt(n, 10));
    return ' ';
  });
  // --limit N
  q = q.replace(/(^|\s)--limit\s+(\d+)(\s|$)/g, (_m, _a, n, _b) => {
    limit = Math.max(1, parseInt(n, 10));
    return ' ';
  });

  return { query: q.trim(), cap, limit, full };
}

// Indent a multi-line string by two spaces so it nests visually under
// the bullet marker. Preserves the original newlines (no whitespace
// collapsing — that destroys formulas, code blocks, lists).
function indentBody(text) {
  return String(text || '')
    .split('\n')
    .map((ln) => `  ${ln}`)
    .join('\n');
}

function createMemorySearchTool({ search, limit: defaultLimit = 5, minConfidence = 0.5 } = {}) {
  if (typeof search !== 'function') {
    throw new Error('createMemorySearchTool: search(query, opts) function is required');
  }
  return {
    id: 'memory-search',
    name: 'Memory Search',
    description:
      'Search prior MyAgent session transcripts and saved notes. Use ' +
      'when the user references earlier conversations ("we talked ' +
      'about", "last time", "have we done this before"), asks how ' +
      'something was previously decided, or wants to recall past ' +
      'work. Searches the project session index (BM25 + cosine).',
    usage: [
      '/memory-search lens thickness',
      '/memory-search lens thickness --full         (no truncation)',
      '/memory-search lens thickness --limit 10     (more hits)',
      '/memory-search lens thickness --cap 500      (smaller per-hit cap)',
      'have we discussed CrewAI before',
      'recall notes about the browser tab feature',
    ],
    async run({ input }) {
      const opts = parseOptions(input);
      if (!opts.query) return { ok: false, text: 'Memory search needs a query.' };
      const limit = opts.limit || defaultLimit;
      let hits;
      try {
        hits = await search({ query: opts.query, limit, minConfidence });
      } catch (err) {
        return { ok: false, text: `Memory search failed: ${err.message}` };
      }
      const list = Array.isArray(hits) ? hits : (hits && hits.hits) || [];
      if (list.length === 0) {
        return { ok: true, text: `No matches for "${opts.query}".`, data: { hits: [] } };
      }
      const cap = opts.full ? 0 : opts.cap;   // 0 = unbounded
      const lines = list.slice(0, limit).map((h) => {
        const ts = h.ts ? new Date(h.ts).toISOString().slice(0, 19).replace('T', ' ') : '';
        const conf = typeof h.confidence === 'number' ? ` (conf ${h.confidence.toFixed(2)})` : '';
        // Prefer the full `text` field over the index's pre-truncated
        // `snippet`. Whitespace and newlines are preserved verbatim
        // — formulas, code blocks, and lists need them.
        const fullBody = String(h.text || h.snippet || '');
        let body = fullBody;
        let truncatedNote = '';
        if (cap > 0 && body.length > cap) {
          body = body.slice(0, cap);
          truncatedNote = `\n  … (${fullBody.length - cap} more chars — re-run with --full or --cap ${fullBody.length})`;
        }
        return `• ${ts}${conf}\n${indentBody(body)}${truncatedNote}`;
      });
      const header = `Found ${list.length} match${list.length === 1 ? '' : 'es'} for "${opts.query}":`;
      return {
        ok: true,
        text: `${header}\n${lines.join('\n\n')}`,
        data: { hits: list, options: opts },
      };
    },
  };
}

module.exports = { createMemorySearchTool, parseOptions, indentBody };
