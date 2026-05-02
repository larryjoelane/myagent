// ToolKit — registry of Tool objects.
//
// A Tool is a plain object:
//   {
//     id          : string, unique within a ToolKit (kebab-case recommended)
//     name        : string, short human label for UI ("Memory Search")
//     description : string, used by the router to score relevance.
//                    Write it like a search-engine snippet: include the
//                    *kinds of user prompts* that should hit this tool.
//                    Better descriptions = better routing. Several
//                    sentences is fine.
//     run         : async ({ input, match, ctx }) -> ToolResult
//   }
//
// ToolResult shape:
//   { ok: boolean, text: string, data?: any }
//
// `text` is what the user sees in the assistant bubble. `data` is
// optional structured output for programmatic callers.
//
// The kit doesn't enforce a schema beyond "must have id + run" — the
// router uses description, the driver uses run, callers can ignore the
// rest. Keep it dumb.

class ToolKit {
  constructor(tools = []) {
    this.tools = new Map();
    for (const t of tools) this.add(t);
  }

  add(tool) {
    if (!tool || typeof tool !== 'object') throw new Error('ToolKit.add: tool must be an object');
    if (!tool.id || typeof tool.id !== 'string') throw new Error('ToolKit.add: tool.id is required');
    if (typeof tool.run !== 'function') throw new Error(`ToolKit.add: tool ${tool.id} missing run()`);
    if (this.tools.has(tool.id)) throw new Error(`ToolKit.add: duplicate tool id "${tool.id}"`);
    // Preserve everything the tool exposes (usage, hints, version, …).
    // Required-field defaults are layered on top so id/name/description
    // are always present.
    this.tools.set(tool.id, {
      ...tool,
      id: tool.id,
      name: tool.name || tool.id,
      description: tool.description || '',
      run: tool.run,
    });
    return this;
  }

  get(id) { return this.tools.get(id) || null; }

  list() { return [...this.tools.values()]; }

  has(id) { return this.tools.has(id); }

  size() { return this.tools.size; }
}

module.exports = { ToolKit };
