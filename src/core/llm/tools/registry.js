// Tool registry — collects LLM tool modules and produces (a) the OpenAI
// tool-schema array to send with each chat request and (b) a dispatcher
// that runs a parsed tool_call against the right implementation.
//
// Each tool module exports:
//   {
//     name        : string, kebab- or snake-cased; sent to the model as-is
//     description : string, natural-language; helps the model pick it
//     parameters  : JSONSchema for arguments (OpenAI tool-call shape)
//     async run(args, ctx)  -> { ok, content, data? }
//                   ctx = { scope, cwd, signal, abortSignal, onEvent }
//                   `content` is the string returned to the model in the
//                   tool message. `data` is optional structured output for
//                   programmatic callers / events.
//   }
//
// The registry enforces no security policy of its own — tools are
// expected to consult ctx.scope before any fs.* call. Phase 6 / ADR-0008.

class ToolRegistry {
  constructor(tools = []) {
    /** @type {Map<string, object>} */
    this._tools = new Map();
    for (const t of tools) this.add(t);
  }

  add(tool) {
    if (!tool || typeof tool !== 'object') throw new Error('ToolRegistry.add: tool must be an object');
    if (!tool.name || typeof tool.name !== 'string') throw new Error('ToolRegistry.add: tool.name is required');
    if (typeof tool.run !== 'function') throw new Error(`ToolRegistry.add: tool ${tool.name} missing run()`);
    if (this._tools.has(tool.name)) throw new Error(`ToolRegistry.add: duplicate tool name "${tool.name}"`);
    this._tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      run: tool.run,
    });
    return this;
  }

  get(name) { return this._tools.get(name) || null; }
  has(name) { return this._tools.has(name); }
  list() { return [...this._tools.values()]; }
  size() { return this._tools.size; }

  // OpenAI tool-schema array — pass to OpenAIChat.stream({ tools }).
  toOpenAISchema() {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  // Dispatch a parsed tool_call. Always resolves — errors become
  // { ok: false, content: '...' } so the loop can feed the result back
  // to the model rather than aborting the turn.
  async dispatch(call, ctx = {}) {
    const tool = this._tools.get(call.name);
    if (!tool) {
      return { ok: false, content: `unknown tool "${call.name}"` };
    }
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* keep string */ }
    }
    try {
      const result = await tool.run(args || {}, ctx);
      if (!result || typeof result !== 'object') {
        return { ok: false, content: `tool "${call.name}" returned non-object result` };
      }
      return result;
    } catch (err) {
      return { ok: false, content: `tool "${call.name}" threw: ${err && err.message ? err.message : String(err)}` };
    }
  }
}

module.exports = { ToolRegistry };
