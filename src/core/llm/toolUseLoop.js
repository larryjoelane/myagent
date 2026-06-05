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
//   - maxIterations defaults to 30. Real refactors do 20+ tool calls;
//     anything lower silently truncates. A model stuck in a runaway loop
//     will still hit this and the turn ends with a synthetic content
//     note. Callers override via the constructor option, and drivers
//     accept a configurable maxIterations that propagates here.

const DEFAULT_MAX_ITERATIONS = 30;

class ToolUseLoop {
  constructor({
    runner,
    registry,
    ctx = {},
    onEvent,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    parallelDispatch = true,
    toolArgsFormat = 'object',
    beforeSend = null,
    beforeTool = null,
  } = {}) {
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
    // When true, all tool_calls from a single assistant turn dispatch
    // concurrently via Promise.all. Event ordering still matches the
    // model's emit order — tool-call and tool-result events are emitted
    // in original-call order after all results settle. Disable when a
    // backend has tools that mutate shared state in surprising ways.
    this.parallelDispatch = parallelDispatch !== false;
    // Serialization shape for tool-call `arguments` in assistant history:
    //   'object' — Ollama's /api/chat requires a structured object.
    //   'string' — OpenAI/OpenRouter require a JSON-encoded string and 400
    //              on an object.
    this.toolArgsFormat = toolArgsFormat === 'string' ? 'string' : 'object';
    // Optional pre-send gate. Called with ({ messages, iteration }) right
    // BEFORE every runner.stream() — i.e. the user send (iter 1) AND each
    // tool-loop re-entry (iter 2+), so tool results are gated too. Must
    // resolve to { allow: boolean, reason?, blockedBy? }. allow:false
    // stops the loop without an LLM request. Provider-neutral: this is how
    // pre-LLM hooks plug in (see hookRunner.js) without the loop importing
    // them directly.
    this.beforeSend = typeof beforeSend === 'function' ? beforeSend : null;
    // Optional pre-tool gate. Called with ({ call, iteration }) right BEFORE
    // each registry.dispatch(). Must resolve to { allow, reason?, blockedBy? }.
    // Unlike beforeSend, a block here does NOT stop the loop: the tool is
    // skipped and a synthetic { ok:false } tool message is fed back so the
    // model sees the refusal and can react (pick a different tool, explain,
    // etc.). This is how pre-tool hooks plug in (see hookRunner.js) — e.g.
    // a no-secrets guard that stops a file write from reaching disk.
    this.beforeTool = typeof beforeTool === 'function' ? beforeTool : null;
  }

  // Run the pre-tool gate for one call. Returns the dispatch result when the
  // call is allowed (awaiting the real dispatch), or a synthetic blocked
  // result when a hook refuses it — never throwing, so it slots into both
  // the parallel and sequential dispatch paths uniformly. The 'tool-blocked'
  // event lets the UI surface the refusal distinctly from a tool error.
  async _dispatchGated(call, iteration, ctx) {
    if (this.beforeTool) {
      let decision;
      try {
        decision = await this.beforeTool({ call, iteration });
      } catch (err) {
        // Fail-closed: a gate that throws blocks the tool.
        decision = { allow: false, reason: `pre-tool gate threw: ${err?.message || String(err)}` };
      }
      if (decision && decision.allow === false) {
        const reason = decision.reason || 'blocked by a pre-tool hook';
        this.onEvent({
          type: 'tool-blocked',
          call,
          reason,
          blockedBy: decision.blockedBy || null,
          iteration,
        });
        return { ok: false, content: `Tool "${call.name}" blocked by guardrail: ${reason}`, blocked: true };
      }
    }
    return this.registry.dispatch(call, ctx);
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

      // Pre-send gate (pre-LLM hooks). Runs before EVERY runner.stream(),
      // so it sees the user prompt on iter 1 and every tool result on
      // later iters. A block stops the loop with NO LLM request made.
      if (this.beforeSend) {
        const decision = await this.beforeSend({ messages: out, iteration: iter });
        if (decision && decision.allow === false) {
          const reason = decision.reason || 'blocked by a pre-LLM hook';
          this.onEvent({
            type: 'hook-blocked',
            reason,
            blockedBy: decision.blockedBy || null,
            iteration: iter,
          });
          this.onEvent({
            type: 'done',
            assistantText,
            iterations: iter,
            totals,
            blocked: true,
            blockReason: reason,
          });
          return {
            messages: out, assistantText, iterations: iter, totals,
            blocked: true, blockReason: reason, blockedBy: decision.blockedBy || null,
          };
        }
      }

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
        tool_calls: turnCalls.map((c) => toAssistantToolCall(c, this.toolArgsFormat)),
      });

      // Dispatch calls. In parallel mode all calls fire concurrently
      // via Promise.all; we still emit tool-call/tool-result events
      // and append tool messages in the model's original emit order so
      // the conversation history and the event stream are deterministic.
      // Sequential mode preserves the older one-at-a-time behavior for
      // callers that need it.
      if (this.parallelDispatch && turnCalls.length > 1) {
        for (const call of turnCalls) this.onEvent({ type: 'tool-call', call });
        const results = await Promise.all(
          turnCalls.map((call) => this._dispatchGated(call, iter, { ...this.ctx, signal }))
        );
        for (let i = 0; i < turnCalls.length; i += 1) {
          const call = turnCalls[i];
          const result = results[i];
          this.onEvent({ type: 'tool-result', call, result });
          out.push(toolMessage(call, result));
        }
      } else {
        for (const call of turnCalls) {
          this.onEvent({ type: 'tool-call', call });
          const result = await this._dispatchGated(call, iter, { ...this.ctx, signal });
          this.onEvent({ type: 'tool-result', call, result });
          out.push(toolMessage(call, result));
        }
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

// Build a tool message conforming to both Ollama and OpenAI shapes.
// Ollama's tool message: { role: 'tool', content }. OpenAI's adds
// tool_call_id. Ollama rejects extra `name` fields with a 400; we
// never include `name`.
function toolMessage(call, result) {
  const msg = {
    role: 'tool',
    content: typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content ?? null),
  };
  if (call.id) msg.tool_call_id = call.id;
  return msg;
}

function toAssistantToolCall(call, argsFormat = 'object') {
  // Round-trip the call back into a shape the provider accepts.
  //   - `function: { name, arguments }` envelope (both accept).
  //   - `arguments` serialization depends on the provider:
  //       'object' — Ollama's /api/chat requires a structured object.
  //       'string' — OpenAI/OpenRouter require a JSON-encoded string and
  //                  reject an object with a 400 ("expected a string, but
  //                  got an object instead").
  //   - Preserve `id` and `type: 'function'` WHEN the model emitted an
  //     id. Both fields are required by Ollama Cloud for any model that
  //     issues correlation ids (e.g. ministral-3:3b-cloud, which sends
  //     `tool_calls: [{ id: "abc", function: {...} }]`). Without the
  //     matching id on the assistant turn, the next request fails with
  //     `Unexpected tool call id <X> in tool results`. Models that
  //     never emit an id (e.g. gpt-oss family) get an envelope without
  //     these fields, so the historical "id-free" path stays intact.
  let args = call.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== 'object') args = {};
  const serialized = argsFormat === 'string' ? JSON.stringify(args) : args;
  const envelope = { function: { name: call.name, arguments: serialized } };
  if (call.id) {
    envelope.id = call.id;
    envelope.type = 'function';
  }
  return envelope;
}

module.exports = { ToolUseLoop, DEFAULT_MAX_ITERATIONS };
