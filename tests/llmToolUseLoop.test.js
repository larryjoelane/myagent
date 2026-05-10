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
    // Sending it as a string was the cause of the live-API 400.
    deepEq(result.messages[1].tool_calls[0].function.arguments, { message: 'pong' });
    // Ollama-shape: no top-level `id` / `type` on the tool_call.
    eq(result.messages[1].tool_calls[0].id, undefined);
    eq(result.messages[1].tool_calls[0].type, undefined);
    // Ollama-shape: tool message has no `name` field. tool_call_id is
    // included only when the model provided one.
    eq(result.messages[2].name, undefined);
    eq(result.messages[2].tool_call_id, 'c1');
    eq(result.messages[2].content, 'pong');

    ok(events.some((e) => e.type === 'tool-call' && e.call.name === 'echo'));
    ok(events.some((e) => e.type === 'tool-result' && e.result.ok === true));
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
}

module.exports = { run };
