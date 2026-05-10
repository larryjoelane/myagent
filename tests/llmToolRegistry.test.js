// Tests for the OpenAI-shape ToolRegistry: schema generation, dispatch,
// error envelopes, duplicate-name guarding.

const { ToolRegistry } = require('../src/core/llm/tools/registry');
const echo = require('../src/core/llm/tools/echo');
const { eq, ok, deepEq } = require('./assert');

function run(ctx) {
  ctx.test('add() requires name and run()', () => {
    const r = new ToolRegistry();
    let threw;
    try { r.add({ run: () => {} }); } catch (e) { threw = e; }
    ok(threw && /name/.test(threw.message));
    threw = null;
    try { r.add({ name: 'x' }); } catch (e) { threw = e; }
    ok(threw && /run/.test(threw.message));
  });

  ctx.test('add() rejects duplicate names', () => {
    const r = new ToolRegistry();
    r.add(echo);
    let threw;
    try { r.add(echo); } catch (e) { threw = e; }
    ok(threw && /duplicate/.test(threw.message));
  });

  ctx.test('toOpenAISchema() produces function-shaped tools', () => {
    const r = new ToolRegistry([echo]);
    const schema = r.toOpenAISchema();
    eq(schema.length, 1);
    eq(schema[0].type, 'function');
    eq(schema[0].function.name, 'echo');
    ok(schema[0].function.description.length > 0);
    eq(schema[0].function.parameters.type, 'object');
  });

  ctx.test('dispatch() runs the named tool with parsed args', async () => {
    const r = new ToolRegistry([echo]);
    const result = await r.dispatch({ name: 'echo', arguments: { message: 'hi' } });
    eq(result.ok, true);
    eq(result.content, 'hi');
  });

  ctx.test('dispatch() parses string-form arguments (OpenAI SSE shape)', async () => {
    const r = new ToolRegistry([echo]);
    const result = await r.dispatch({ name: 'echo', arguments: '{"message":"hello"}' });
    eq(result.ok, true);
    eq(result.content, 'hello');
  });

  ctx.test('dispatch() returns ok:false for unknown tool', async () => {
    const r = new ToolRegistry([echo]);
    const result = await r.dispatch({ name: 'nope', arguments: {} });
    eq(result.ok, false);
    ok(/unknown tool/.test(result.content));
  });

  ctx.test('dispatch() catches thrown errors and returns ok:false', async () => {
    const r = new ToolRegistry();
    r.add({ name: 'boom', run: async () => { throw new Error('kaboom'); } });
    const result = await r.dispatch({ name: 'boom', arguments: {} });
    eq(result.ok, false);
    ok(/kaboom/.test(result.content));
  });

  ctx.test('dispatch() forwards ctx to the tool', async () => {
    const r = new ToolRegistry();
    let seen;
    r.add({ name: 'spy', run: async (_a, c) => { seen = c; return { ok: true, content: 'ok' }; } });
    await r.dispatch({ name: 'spy', arguments: {} }, { cwd: '/x', scope: { tag: 's' } });
    eq(seen.cwd, '/x');
    deepEq(seen.scope, { tag: 's' });
  });
}

module.exports = { run };
