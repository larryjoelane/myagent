// Sanity tests for the echo tool module.

const echo = require('../src/core/llm/tools/echo');
const { eq, ok } = require('./assert');

function run(ctx) {
  ctx.test('echo: name and parameters are well-formed', () => {
    eq(echo.name, 'echo');
    eq(echo.parameters.type, 'object');
    ok(echo.parameters.properties.message);
    ok(Array.isArray(echo.parameters.required));
  });

  ctx.test('echo: returns the message verbatim', async () => {
    const r = await echo.run({ message: 'hello world' });
    eq(r.ok, true);
    eq(r.content, 'hello world');
  });

  ctx.test('echo: missing message coerces to empty string', async () => {
    const r = await echo.run({});
    eq(r.ok, true);
    eq(r.content, '');
  });
}

module.exports = { run };
