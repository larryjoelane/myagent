// memory_store — companion to memory_search. Saves a note so future
// sessions can recall it.
//
// Args:
//   { text: string, tags?: string[], source?: string }
//
// Dependency injection:
//   ctx.memory.store(body) — see electron/main.js where indexHost.storeMemory
//   is bound. When missing, the tool refuses cleanly.

module.exports = {
  name: 'memory_store',
  description:
    'Save a note to persistent memory so future sessions can recall it. ' +
    'Use when the user explicitly asks to remember, save, or note ' +
    'something durable. Do not use for ephemeral task state.',
  parameters: {
    type: 'object',
    properties: {
      text:   { type: 'string', description: 'The note body to save.' },
      tags:   { type: 'array',  items: { type: 'string' }, description: 'Optional tags (defaults to ["llm","note"]).' },
      source: { type: 'string', description: 'Optional source label (defaults to "llm").' },
    },
    required: ['text'],
  },
  async run(args, ctx = {}) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, content: 'memory_store: missing required argument "text"' };

    const store = ctx.memory && typeof ctx.memory.store === 'function' ? ctx.memory.store : null;
    if (!store) return { ok: false, content: 'memory_store: refused — no memory backend on context' };

    const tags = Array.isArray(args.tags) && args.tags.length > 0
      ? args.tags.map(String)
      : ['llm', 'note'];
    const source = args.source ? String(args.source) : 'llm';

    let result;
    try { result = await store({ text, source, tags }); }
    catch (err) { return { ok: false, content: `memory_store: save failed: ${err.message}` }; }

    const id = result && (result.id ?? result.rowId);
    const idTail = id != null ? ` (#${id})` : '';
    return {
      ok: true,
      content: `Saved${idTail}: ${text.length > 200 ? text.slice(0, 200) + '…' : text}`,
      data: { id, text, source, tags },
    };
  },
};
