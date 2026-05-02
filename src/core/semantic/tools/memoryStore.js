// Memory Store — companion to memory-search. Saves a note to the
// session index so future runs can recall it.
//
// Argument extraction:
//   We strip a leading verb phrase ("remember that", "save this",
//   "note:", "memo:") and use the remainder as the body. If nothing
//   is left, the entire input is treated as the body.

function extractBody(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // Match each leading-verb prefix tolerantly. The "this" / "note"
  // qualifiers may be followed by `:`, whitespace, or both — the
  // earlier shape `(this\s+)?` missed "save this:".
  const stripped = s
    .replace(/^(please\s+)?(remember\s+(that\s+|this[:\s]+)?|save\s+(this[:\s]+|note[:\s]+)?|note\s*[:.\-]\s*|memo\s*[:.\-]\s*|store\s+(this[:\s]+|note[:\s]+)?)/i, '')
    .trim();
  return stripped || s;
}

function createMemoryStoreTool({ store } = {}) {
  if (typeof store !== 'function') {
    throw new Error('createMemoryStoreTool: store(body) function is required');
  }
  return {
    id: 'memory-store',
    name: 'Memory Store',
    description:
      'Save a note to persistent memory so future sessions can recall ' +
      'it. Use for prompts like "remember that X", "save this: Y", ' +
      '"note: ...", "memo: ...", "make a note that Z". Companion to ' +
      'memory search. Do not use for ephemeral task state.',
    usage: [
      '/memory-store the build script lives at scripts/build.js',
      'remember that we use snake_case in db_*.py',
      'save this: PR template lives in .github/PULL_REQUEST_TEMPLATE.md',
      'note: deployment runs nightly at 02:00 UTC',
    ],
    async run({ input, ctx }) {
      const body = extractBody(input);
      if (!body) return { ok: false, text: 'Nothing to remember.' };
      try {
        const result = await store({
          text: body,
          source: ctx?.agentId ? `semantic:${ctx.agentId}` : 'semantic',
          tags: ['semantic', 'note'],
        });
        const id = result && (result.id ?? result.rowId);
        const idTail = id != null ? ` (#${id})` : '';
        return {
          ok: true,
          text: `Saved${idTail}: ${body.length > 200 ? body.slice(0, 200) + '…' : body}`,
          data: { id, text: body },
        };
      } catch (err) {
        return { ok: false, text: `Save failed: ${err.message}` };
      }
    },
  };
}

module.exports = { createMemoryStoreTool, extractBody };
