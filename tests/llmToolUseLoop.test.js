// Tests for ToolUseLoop. Drives the loop with a fake runner whose
// stream() yields scripted structured events per turn — same shape as
// what OpenAIChat produces. Covers: no-tool happy path, single tool
// dispatch, multi-iteration tool chains, max-iteration cap, error
// envelopes from tool throws.

const { ToolUseLoop } = require('../src/core/llm/toolUseLoop');
const { ToolRegistry } = require('../src/core/llm/tools/registry');
const { eq, ok, deepEq } = require('./assert');

function fakeRunner(turns) {
  // turns: array of arrays of events. One inner array per call to stream().
  let i = 0;
  return {
    async *stream() {
      const events = turns[i] || [];
      i += 1;
      for (const ev of events) yield ev;
    },
    callCount() { return i; },
  };
}

function run(ctx) {
  ctx.test('no tool calls -> done after one iteration', async () => {
    const runner = fakeRunner([
      [{ type: 'content', text: 'hello world' }, { type: 'done', totals: {} }],
    ]);
    const registry = new ToolRegistry();
    const events = [];
    const loop = new ToolUseLoop({ runner, registry, onEvent: (e) => events.push(e) });
    const result = await loop.run([{ role: 'user', content: 'hi' }]);
    eq(result.iterations, 1);
    eq(result.assistantText, 'hello world');
    const last = result.messages[result.messages.length - 1];
    eq(last.role, 'assistant');
    eq(last.content, 'hello world');
    ok(events.some((e) => e.type === 'content' && e.text === 'hello world'));
    ok(events.some((e) => e.type === 'done'));
  });

  ctx.test('single tool call dispatched, then final answer on next iteration', async () => {
    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { message: 'pong' } } },
        { type: 'done', totals: {} },
      ],
      [
        { type: 'content', text: 'I echoed: pong' },
        { type: 'done', totals: {} },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const events = [];
    const loop = new ToolUseLoop({ runner, registry, onEvent: (e) => events.push(e) });
    const result = await loop.run([{ role: 'user', content: 'echo pong' }]);
    eq(result.iterations, 2);
    eq(result.assistantText, 'I echoed: pong');

    // Message log should include: user, assistant(tool_calls), tool, assistant(final).
    const roles = result.messages.map((m) => m.role);
    deepEq(roles, ['user', 'assistant', 'tool', 'assistant']);
    eq(result.messages[1].tool_calls[0].function.name, 'echo');
    // Ollama-shape: arguments is a STRUCTURED OBJECT, not a JSON string.
    // Sending it as a string was the cause of an earlier live-API 400.
    deepEq(result.messages[1].tool_calls[0].function.arguments, { message: 'pong' });
    // When the model emitted an id, we MUST round-trip it onto the
    // assistant turn so the matching tool_call_id on the tool message
    // resolves. Ollama Cloud (ministral-3 et al) returns HTTP 400
    // "Unexpected tool call id" otherwise. `type: 'function'` is sent
    // together so the OpenAI shape is complete.
    eq(result.messages[1].tool_calls[0].id, 'c1');
    eq(result.messages[1].tool_calls[0].type, 'function');
    // Tool message: no `name` field; tool_call_id round-trips.
    eq(result.messages[2].name, undefined);
    eq(result.messages[2].tool_call_id, 'c1');
    eq(result.messages[2].content, 'pong');

    ok(events.some((e) => e.type === 'tool-call' && e.call.name === 'echo'));
    ok(events.some((e) => e.type === 'tool-result' && e.result.ok === true));
  });

  ctx.test('id-less tool_call: no id/type on assistant turn, no tool_call_id on tool msg', async () => {
    // Models like gpt-oss don't send an id with their tool_calls. We
    // must not synthesize one — and we must not put tool_call_id on
    // the tool message either, since there'd be nothing to correlate
    // with. Symmetry guards against the "Unexpected tool call id" 400
    // AND its inverse where a stranded tool_call_id would surprise the
    // server.
    const runner = fakeRunner([
      [
        // No id on the tool_call.
        { type: 'tool_call', call: { name: 'echo', arguments: { message: 'noid' } } },
        { type: 'done', totals: {} },
      ],
      [
        { type: 'content', text: 'done' },
        { type: 'done', totals: {} },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const loop = new ToolUseLoop({ runner, registry });
    const result = await loop.run([{ role: 'user', content: 'go' }]);

    eq(result.messages[1].tool_calls[0].function.name, 'echo');
    eq(result.messages[1].tool_calls[0].id, undefined);
    eq(result.messages[1].tool_calls[0].type, undefined);
    eq(result.messages[2].role, 'tool');
    eq(result.messages[2].tool_call_id, undefined);
  });

  ctx.test("toolArgsFormat: 'string' serializes arguments as a JSON string (OpenAI/OpenRouter)", async () => {
    // OpenRouter forwards to the strict OpenAI schema, which 400s on an
    // object: "Invalid type for 'messages[N].tool_calls[0].function.
    // arguments': expected a string, but got an object instead." The
    // 'string' format must JSON-encode the args while preserving id/type.
    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { message: 'pong' } } },
        { type: 'done', totals: {} },
      ],
      [
        { type: 'content', text: 'done' },
        { type: 'done', totals: {} },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const loop = new ToolUseLoop({ runner, registry, toolArgsFormat: 'string' });
    const result = await loop.run([{ role: 'user', content: 'echo pong' }]);
    const args = result.messages[1].tool_calls[0].function.arguments;
    eq(typeof args, 'string');
    deepEq(JSON.parse(args), { message: 'pong' });
    // id/type still round-trip in string mode.
    eq(result.messages[1].tool_calls[0].id, 'c1');
    eq(result.messages[1].tool_calls[0].type, 'function');
  });

  ctx.test('tool that throws is captured by registry, fed back to model', async () => {
    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'boom', arguments: {} } },
        { type: 'done', totals: {} },
      ],
      [
        { type: 'content', text: 'I see the error' },
        { type: 'done', totals: {} },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.add({ name: 'boom', run: async () => { throw new Error('kaboom'); } });
    const events = [];
    const loop = new ToolUseLoop({ runner, registry, onEvent: (e) => events.push(e) });
    const result = await loop.run([{ role: 'user', content: 'go' }]);
    eq(result.iterations, 2);
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    ok(toolMsg && /kaboom/.test(toolMsg.content));
  });

  ctx.test('default maxIterations is 30', async () => {
    const { DEFAULT_MAX_ITERATIONS } = require('../src/core/llm/toolUseLoop');
    eq(DEFAULT_MAX_ITERATIONS, 30);
  });

  ctx.test('parallel dispatch: tools run concurrently, events stay in call order', async () => {
    const sleepTool = {
      name: 'sleep',
      description: 'sleep ms',
      parameters: { type: 'object', properties: { ms: { type: 'integer' }, label: { type: 'string' } } },
      async run(args) {
        await new Promise((r) => setTimeout(r, args.ms || 0));
        return { ok: true, content: `slept ${args.label}` };
      },
    };
    const registry = new ToolRegistry();
    registry.add(sleepTool);

    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: 'a', name: 'sleep', arguments: { ms: 100, label: 'first' } } },
        { type: 'tool_call', call: { id: 'b', name: 'sleep', arguments: { ms: 100, label: 'second' } } },
        { type: 'tool_call', call: { id: 'c', name: 'sleep', arguments: { ms: 100, label: 'third' } } },
        { type: 'done', totals: {} },
      ],
      [{ type: 'content', text: 'all done' }, { type: 'done', totals: {} }],
    ]);
    const events = [];
    const loop = new ToolUseLoop({ runner, registry, onEvent: (e) => events.push(e) });
    const t0 = Date.now();
    const result = await loop.run([{ role: 'user', content: 'race' }]);
    const elapsed = Date.now() - t0;

    // Three 100ms tools in parallel must take well under the 300ms a
    // serial run would need. Generous margin for CI jitter.
    ok(elapsed < 250, `expected parallel run to be <250ms, took ${elapsed}ms`);
    eq(result.assistantText, 'all done');

    // Event order: all three tool-call events first (in original order),
    // then all three tool-result events (also in original order).
    const callEvents = events.filter((e) => e.type === 'tool-call');
    const resultEvents = events.filter((e) => e.type === 'tool-result');
    eq(callEvents.length, 3);
    eq(resultEvents.length, 3);
    eq(callEvents[0].call.id, 'a');
    eq(callEvents[1].call.id, 'b');
    eq(callEvents[2].call.id, 'c');
    eq(resultEvents[0].call.id, 'a');
    eq(resultEvents[1].call.id, 'b');
    eq(resultEvents[2].call.id, 'c');

    // Tool messages appended in original-call order too.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    eq(toolMsgs.length, 3);
    eq(toolMsgs[0].tool_call_id, 'a');
    eq(toolMsgs[1].tool_call_id, 'b');
    eq(toolMsgs[2].tool_call_id, 'c');
  });

  ctx.test('parallelDispatch=false runs tools sequentially', async () => {
    const order = [];
    const seqTool = {
      name: 'seq',
      description: 'sequence marker',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      async run(args) {
        order.push(`start-${args.id}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end-${args.id}`);
        return { ok: true, content: args.id };
      },
    };
    const registry = new ToolRegistry();
    registry.add(seqTool);

    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: '1', name: 'seq', arguments: { id: 'A' } } },
        { type: 'tool_call', call: { id: '2', name: 'seq', arguments: { id: 'B' } } },
        { type: 'done', totals: {} },
      ],
      [{ type: 'content', text: 'ok' }, { type: 'done', totals: {} }],
    ]);
    const loop = new ToolUseLoop({ runner, registry, parallelDispatch: false });
    await loop.run([{ role: 'user', content: 'x' }]);
    // Strict sequential: A finishes before B starts.
    deepEq(order, ['start-A', 'end-A', 'start-B', 'end-B']);
  });

  ctx.test('hits maxIterations when model never stops calling tools', async () => {
    const turns = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push([
        { type: 'tool_call', call: { id: `c${i}`, name: 'echo', arguments: { message: String(i) } } },
        { type: 'done', totals: {} },
      ]);
    }
    const runner = fakeRunner(turns);
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const loop = new ToolUseLoop({ runner, registry, maxIterations: 3 });
    const result = await loop.run([{ role: 'user', content: 'go' }]);
    eq(result.iterations, 3);
    eq(result.hitMaxIterations, true);
    ok(/maxIterations=3/.test(result.assistantText));
  });

  ctx.test('schemas from registry get passed to runner.stream', async () => {
    const seen = [];
    const runner = {
      async *stream(_msgs, opts) {
        seen.push(opts);
        yield { type: 'content', text: 'ok' };
        yield { type: 'done', totals: {} };
      },
    };
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const loop = new ToolUseLoop({ runner, registry });
    await loop.run([{ role: 'user', content: 'hi' }]);
    ok(Array.isArray(seen[0].tools));
    eq(seen[0].tools[0].function.name, 'echo');
  });

  ctx.test('thinking events forwarded to onEvent but not into assistantText', async () => {
    const runner = fakeRunner([
      [
        { type: 'thinking', text: 'pondering... ' },
        { type: 'content', text: 'final' },
        { type: 'done', totals: {} },
      ],
    ]);
    const registry = new ToolRegistry();
    const events = [];
    const loop = new ToolUseLoop({ runner, registry, onEvent: (e) => events.push(e) });
    const result = await loop.run([{ role: 'user', content: 'hi' }]);
    eq(result.assistantText, 'final');
    ok(events.some((e) => e.type === 'thinking'));
  });

  // ----- beforeSend gate (pre-LLM hooks) ---------------------------------

  ctx.test('beforeSend block on iteration 1: NO LLM request is made', async () => {
    const runner = fakeRunner([
      [{ type: 'content', text: 'should never run' }, { type: 'done', totals: {} }],
    ]);
    const registry = new ToolRegistry();
    const events = [];
    const loop = new ToolUseLoop({
      runner, registry,
      onEvent: (e) => events.push(e),
      beforeSend: () => ({ allow: false, reason: 'contains a secret', blockedBy: 'no-secrets' }),
    });
    const result = await loop.run([{ role: 'user', content: 'my password is hunter2' }]);
    eq(runner.callCount(), 0, 'runner.stream must not be called when blocked');
    eq(result.blocked, true);
    eq(result.blockReason, 'contains a secret');
    eq(result.blockedBy, 'no-secrets');
    eq(result.assistantText, '');
    ok(events.some((e) => e.type === 'hook-blocked' && e.blockedBy === 'no-secrets'));
    const done = events.find((e) => e.type === 'done');
    eq(done.blocked, true);
  });

  ctx.test('beforeSend allow on every iteration: loop runs normally', async () => {
    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { message: 'x' } } },
        { type: 'done', totals: {} },
      ],
      [{ type: 'content', text: 'done' }, { type: 'done', totals: {} }],
    ]);
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const iterationsSeen = [];
    const loop = new ToolUseLoop({
      runner, registry,
      beforeSend: ({ iteration }) => { iterationsSeen.push(iteration); return { allow: true }; },
    });
    const result = await loop.run([{ role: 'user', content: 'go' }]);
    eq(result.iterations, 2);
    eq(result.blocked, undefined);
    // beforeSend fired before BOTH the user send and the tool re-entry.
    deepEq(iterationsSeen, [1, 2]);
  });

  ctx.test('beforeSend block on iteration 2: gates the tool result re-entry', async () => {
    // First send is allowed and yields a tool call. The hook then blocks
    // the SECOND send (which would carry the tool result back to the LLM).
    const runner = fakeRunner([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { message: 'leak' } } },
        { type: 'done', totals: {} },
      ],
      [{ type: 'content', text: 'must not run' }, { type: 'done', totals: {} }],
    ]);
    const registry = new ToolRegistry();
    registry.add(require('../src/core/llm/tools/echo'));
    const loop = new ToolUseLoop({
      runner, registry,
      beforeSend: ({ iteration, messages }) => {
        if (iteration === 1) return { allow: true };
        // On the re-entry the tool result is present in messages.
        ok(messages.some((m) => m.role === 'tool'), 'tool result present on iter 2');
        return { allow: false, reason: 'tool output blocked' };
      },
    });
    const result = await loop.run([{ role: 'user', content: 'go' }]);
    eq(runner.callCount(), 1, 'only the first send hit the runner');
    eq(result.blocked, true);
    eq(result.iterations, 2);
    eq(result.blockReason, 'tool output blocked');
  });
}

module.exports = { run };
