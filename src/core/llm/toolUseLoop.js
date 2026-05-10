// ToolUseLoop — provider-neutral tool-use driver.
//
// Wraps an OpenAI-format chat runner (OpenAIChat or any preset built on
// it) and a ToolRegistry. Each turn:
//   1. Send messages + tool schemas to the runner.
//   2. Stream structured events. Forward content/thinking to onEvent.
//      Accumulate tool_calls.
//   3. If the assistant finished without tool calls, the turn ends.
//   4. Otherwise, dispatch each tool_call through the registry, append
//      an assistant message with the tool_calls and one tool message
//      per result, and loop. Capped by maxIterations.
//
// Events emitted to onEvent (provider-neutral chat events):
//   { type: 'content',  text }                           - assistant delta
//   { type: 'thinking', text }                           - reasoning delta
//   { type: 'tool-call',   call }                        - tool invocation start
//   { type: 'tool-result', call, result }                - tool finished
//   { type: 'iteration',   n }                           - loop tick
//   { type: 'done', assistantText, iterations, totals }
//
// Notes:
//   - We don't call run() multiple times if the model emits content but
//     no tool_calls — that's a normal answer; the turn is done.
//   - Tool dispatch errors become tool messages with the error string,
//     so the model can recover instead of aborting.
//   - maxIterations defaults to 8. A model stuck in a tool loop will hit
//     this and the turn ends with a synthetic content note.

const DEFAULT_MAX_ITERATIONS = 8;

class ToolUseLoop {
  constructor({ runner, registry, ctx = {}, onEvent, maxIterations = DEFAULT_MAX_ITERATIONS } = {}) {
    if (!runner || typeof runner.stream !== 'function') {
      throw new Error('ToolUseLoop: runner with .stream() is required');
    }
    if (!registry || typeof registry.dispatch !== 'function') {
      throw new Error('ToolUseLoop: registry with .dispatch() is required');
    }
    this.runner = runner;
    this.registry = registry;
    this.ctx = ctx;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.maxIterations = Math.max(1, maxIterations | 0);
  }

  // Run the loop with a starting message list. Returns the final
  // message list (including tool messages and assistant turns) plus
  // accumulated assistant text.
  async run(messages, { signal } = {}) {
    const out = [...messages];
    let assistantText = '';
    let totals = {};
    const tools = this.registry.toOpenAISchema();

    for (let iter = 1; iter <= this.maxIterations; iter += 1) {
      this.onEvent({ type: 'iteration', n: iter });

      const turnText = [];
      const turnCalls = [];
      let turnTotals = {};

      for await (const ev of this.runner.stream(out, { signal, tools })) {
        if (ev.type === 'content') {
          turnText.push(ev.text);
          this.onEvent({ type: 'content', text: ev.text });
          continue;
        }
        if (ev.type === 'thinking') {
          this.onEvent({ type: 'thinking', text: ev.text });
          continue;
        }
        if (ev.type === 'tool_call') {
          turnCalls.push(ev.call);
          continue;
        }
        if (ev.type === 'done') {
          turnTotals = ev.totals || {};
          continue;
        }
      }

      const turnContent = turnText.join('');
      assistantText += turnContent;
      totals = turnTotals;

      // No tool calls → final answer, done.
      if (turnCalls.length === 0) {
        out.push({ role: 'assistant', content: turnContent });
        this.onEvent({
          type: 'done',
          assistantText,
          iterations: iter,
          totals,
        });
        return { messages: out, assistantText, iterations: iter, totals };
      }

      // The assistant turn carries the tool_calls so the model's history
      // matches what it produced. Ollama's /api/chat expects `arguments`
      // as a structured object (NOT a JSON string), and does not want a
      // top-level `id` on the call. OpenAI's API accepts both shapes —
      // string args + id are tolerated — so emitting the Ollama-shape
      // is the lowest common denominator.
      out.push({
        role: 'assistant',
        content: turnContent || '',
        tool_calls: turnCalls.map(toAssistantToolCall),
      });

      // Dispatch each call sequentially. Parallel dispatch is a future
      // optimization — for now one-at-a-time keeps event ordering
      // predictable and doesn't blow up concurrency for fs-touching tools.
      for (const call of turnCalls) {
        this.onEvent({ type: 'tool-call', call });
        const result = await this.registry.dispatch(call, { ...this.ctx, signal });
        this.onEvent({ type: 'tool-result', call, result });
        // Ollama's tool message: { role: 'tool', content }. OpenAI's:
        // { role: 'tool', tool_call_id, content }. Ollama rejects extra
        // `name` fields on tool messages with a 400. We include
        // tool_call_id only when the model gave us one (OpenAI path),
        // and never include `name`.
        const toolMsg = {
          role: 'tool',
          content: typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content ?? null),
        };
        if (call.id) toolMsg.tool_call_id = call.id;
        out.push(toolMsg);
      }
      // Loop continues — model gets to react to tool results.
    }

    // Hit maxIterations without the model settling. Synthesize a final
    // assistant message so callers always see a clean termination.
    const note = `[tool-use loop hit maxIterations=${this.maxIterations}]`;
    out.push({ role: 'assistant', content: note });
    assistantText += (assistantText ? '\n' : '') + note;
    this.onEvent({
      type: 'done',
      assistantText,
      iterations: this.maxIterations,
      totals,
      hitMaxIterations: true,
    });
    return {
      messages: out,
      assistantText,
      iterations: this.maxIterations,
      totals,
      hitMaxIterations: true,
    };
  }
}

function toAssistantToolCall(call) {
  // Round-trip the call back into a shape both Ollama and OpenAI accept.
  //   - `arguments` as a structured object (Ollama requires this; OpenAI
  //     tolerates both object and string).
  //   - `function: { name, arguments }` envelope (both accept).
  //   - omit top-level `id` and `type` — Ollama rejects unknown fields
  //     on tool_calls with a 400; OpenAI doesn't require them on the
  //     assistant-history echo.
  let args = call.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== 'object') args = {};
  return {
    function: { name: call.name, arguments: args },
  };
}

module.exports = { ToolUseLoop, DEFAULT_MAX_ITERATIONS };
