// memory_search — search the project's session index for prior work.
//
// Args:
//   { query: string, limit?: number, full?: boolean, cap?: number,
//     min_confidence?: number }
//
// Dependency injection:
//   The search function is read from ctx.memory.search. Wire it at the
//   driver level — see electron/main.js where indexHost.search is bound.
//   When ctx.memory.search is missing, the tool refuses cleanly so it
//   degrades gracefully in tests and minimal embeds.

const DEFAULT_BODY_CAP = 2000;
const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_CONFIDENCE = 0.5;

function indentBody(text) {
  return String(text || '')
    .split('\n')
    .map((ln) => `  ${ln}`)
    .join('\n');
}

module.exports = {
  name: 'memory_search',
  description:
    'Search prior MyAgent session transcripts and saved notes (BM25 + ' +
    'cosine). Use when the user references earlier conversations, asks ' +
    'how something was previously decided, or wants to recall past work.',
  parameters: {
    type: 'object',
    properties: {
      query:          { type: 'string', description: 'Natural-language search query.' },
      limit:          { type: 'integer', minimum: 1, description: `Max hits to return. Default ${DEFAULT_LIMIT}.` },
      full:           { type: 'boolean', description: 'Return untruncated bodies. Overrides cap.' },
      cap:            { type: 'integer', minimum: 0, description: `Per-hit body byte cap. 0 = unlimited. Default ${DEFAULT_BODY_CAP}.` },
      min_confidence: { type: 'number', description: `Filter hits below this confidence (0..1). Default ${DEFAULT_MIN_CONFIDENCE}.` },
    },
    required: ['query'],
  },
  async run(args, ctx = {}) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, content: 'memory_search: missing required argument "query"' };

    const search = ctx.memory && typeof ctx.memory.search === 'function' ? ctx.memory.search : null;
    if (!search) return { ok: false, content: 'memory_search: refused — no memory backend on context' };

    const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
    const minConfidence = Number.isFinite(args.min_confidence) ? args.min_confidence : DEFAULT_MIN_CONFIDENCE;
    const full = !!args.full;
    const cap = full ? 0 : (Number.isFinite(args.cap) && args.cap >= 0 ? Math.floor(args.cap) : DEFAULT_BODY_CAP);

    let hits;
    try { hits = await search({ query, limit, minConfidence }); }
    catch (err) { return { ok: false, content: `memory_search: failed: ${err.message}` }; }

    const list = Array.isArray(hits) ? hits : (hits && hits.hits) || [];
    if (list.length === 0) {
      return { ok: true, content: `No matches for "${query}".`, data: { hits: [], query } };
    }

    const lines = list.slice(0, limit).map((h) => {
      const ts = h.ts ? new Date(h.ts).toISOString().slice(0, 19).replace('T', ' ') : '';
      const conf = typeof h.confidence === 'number' ? ` (conf ${h.confidence.toFixed(2)})` : '';
      const fullBody = String(h.text || h.snippet || '');
      let body = fullBody;
      let truncatedNote = '';
      if (cap > 0 && body.length > cap) {
        body = body.slice(0, cap);
        truncatedNote = `\n  … (${fullBody.length - cap} more chars — re-run with full=true)`;
      }
      return `• ${ts}${conf}\n${indentBody(body)}${truncatedNote}`;
    });
    const header = `Found ${list.length} match${list.length === 1 ? '' : 'es'} for "${query}":`;
    return {
      ok: true,
      content: `${header}\n${lines.join('\n\n')}`,
      data: { hits: list, query, options: { limit, full, cap, minConfidence } },
    };
  },
};
