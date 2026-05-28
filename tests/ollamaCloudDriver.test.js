// OllamaCloudDriver tests. Stubs the runner with a scripted async
// generator and asserts the chat:* event sequence + memory-mirror
// payloads. Same shape as semanticDriver.test.js.

const { OllamaCloudDriver } = require('../src/core/drivers/ollamaCloudDriver');
const { eq, ok, contains, eventually } = require('./assert');

function recorder() {
  const events = [];
  return {
    events,
    onEvent(name, payload) { events.push({ name, payload }); },
    last(name) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].name === name) return events[i];
      return null;
    },
    countOf(name) { return events.filter((e) => e.name === name).length; },
  };
}

// Scripted runner: yields the given chunks in order, optionally throws
// AFTER yielding the chunk at `throwAfter` (so chunks before the throw
// still reach the driver).
function fakeRunner({ chunks = [], throwAfter = -1 } = {}) {
  return {
    capabilities: { thinking: 'never' },
    think: false,
    async health() { return { ok: true }; },
    async setThink() { return { ok: true, think: false }; },
    async *stream() {
      for (let i = 0; i < chunks.length; i++) {
        yield chunks[i];
        if (i === throwAfter) throw new Error('stream blew up');
      }
    },
  };
}

// A runner whose stream() yields one chunk then waits on the abort
// signal forever. Lets us verify cancel() unwedges the driver.
function hangingRunner() {
  return {
    capabilities: { thinking: 'never' },
    think: false,
    async health() { return { ok: true }; },
    async setThink() { return { ok: true, think: false }; },
    async *stream(_messages, { signal } = {}) {
      yield 'first chunk';
      await new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
}

exports.run = (ctx) => {
  ctx.test('start without API key emits error + driver-exit', async () => {
    // Constructor falls back to process.env.OLLAMA_API_KEY when apiKey
    // arg is falsy, so unset it for the duration of this test.
    const saved = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    try {
      const rec = recorder();
      const drv = new OllamaCloudDriver({
        agentId: 'a1',
        runnerFactory: () => fakeRunner(),
        apiKey: null,
        onEvent: rec.onEvent,
      });
      await drv.start();
      contains(rec.last('chat:error').payload.error, 'OLLAMA_API_KEY');
      ok(rec.last('chat:driver-exit'), 'expected driver-exit when key missing');
    } finally {
      if (saved !== undefined) process.env.OLLAMA_API_KEY = saved;
    }
  });

  ctx.test('streams a turn and accumulates assistant text', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['hello ', 'world'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('say hi');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });

    eq(rec.countOf('chat:user'), 1);
    eq(rec.countOf('chat:turn-start'), 1);
    eq(rec.countOf('chat:chunk'), 2);
    eq(rec.countOf('chat:turn-end'), 1);
    eq(rec.last('chat:turn-end').payload.assistantText, 'hello world');
    eq(rec.last('chat:turn-end').payload.userText, 'say hi');
    eq(rec.last('chat:turn-end').payload.ok, true);
  });

  ctx.test('runner failure becomes chat:error + ok:false turn-end', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['ok '], throwAfter: 0 }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('boom');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.last('chat:turn-end').payload.ok, false);
    contains(rec.last('chat:error').payload.error, 'stream blew up');
  });

  ctx.test('cancel() unwedges a hung turn and accepts the next send', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => hangingRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('hang please');
    await eventually(() => eq(rec.countOf('chat:chunk'), 1), { msg: 'first chunk arrived' });

    // While the turn is hung, a second send must be rejected with the
    // "previous turn still in progress" error — this is the actual
    // production wedge the user hit.
    drv.send('queue jumper');
    contains(rec.last('chat:error').payload.error, 'previous turn still in progress');

    // Now cancel — driver should abort the stream and the turn should
    // end with ok:false.
    const cancelled = drv.cancel();
    eq(cancelled, true);
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1), { msg: 'turn ended after cancel' });
    eq(rec.last('chat:turn-end').payload.ok, false);

    // The next send must be accepted (no "previous turn still in
    // progress" error). Swap the runner for a normal one and verify.
    drv.runner = fakeRunner({ chunks: ['ok'] });
    rec.events.length = 0;
    drv.send('after cancel');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1), { msg: 'fresh turn completed' });
    eq(rec.last('chat:turn-end').payload.ok, true);
    eq(rec.last('chat:turn-end').payload.assistantText, 'ok');
  });

  ctx.test('cancel() with no active turn returns false', async () => {
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['x'] }),
      onEvent: () => {},
    });
    await drv.start();
    eq(drv.cancel(), false);
  });

  ctx.test('multi-turn appends to the message history', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['a'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('one');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    drv.send('two');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 2));
    // user, assistant, user, assistant
    eq(drv.messages.length, 4);
    eq(drv.messages[0].role, 'user');
    eq(drv.messages[0].content, 'one');
    eq(drv.messages[1].role, 'assistant');
    eq(drv.messages[2].content, 'two');
  });

  ctx.test('explicit model arg overrides env default', async () => {
    // Constructor honors explicit `model` over process.env.OLLAMA_MODEL.
    // We don't need to touch the env to verify this — we just pass both
    // and inspect what runnerFactory received.
    let runnerOpts = null;
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      model: 'ibm/granite-docling',
      runnerFactory: (opts) => {
        runnerOpts = opts;
        return fakeRunner({ chunks: [] });
      },
      onEvent: () => {},
    });
    await drv.start();
    eq(runnerOpts.model, 'ibm/granite-docling');
    eq(runnerOpts.apiKey, 'fake-key');
  });

  ctx.test('tools mode: routes through ToolUseLoop and emits tool events', async () => {
    const { ToolRegistry } = require('../src/core/llm/tools/registry');
    const echo = require('../src/core/llm/tools/echo');
    const registry = new ToolRegistry();
    registry.add(echo);

    // Scripted preset: turn 1 emits a tool_call, turn 2 emits content.
    let turn = 0;
    const presetFactory = () => ({
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { message: 'pong' } } };
          yield { type: 'done', totals: {} };
        } else {
          yield { type: 'content', text: 'I echoed pong' };
          yield { type: 'done', totals: {} };
        }
      },
    });

    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: [] }),
      presetFactory,
      toolRegistry: registry,
      tools: true,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('echo pong');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });

    eq(rec.countOf('chat:tool-call'), 1);
    eq(rec.last('chat:tool-call').payload.call.name, 'echo');
    eq(rec.countOf('chat:tool-result'), 1);
    eq(rec.last('chat:tool-result').payload.result.ok, true);
    eq(rec.last('chat:tool-result').payload.result.content, 'pong');
    eq(rec.last('chat:turn-end').payload.assistantText, 'I echoed pong');
    eq(rec.last('chat:turn-end').payload.totals.iterations, 2);
  });

  ctx.test('tools mode: requires presetFactory and toolRegistry', () => {
    let threw;
    try {
      new OllamaCloudDriver({
        agentId: 'a1',
        runnerFactory: () => fakeRunner(),
        tools: true,
      });
    } catch (e) { threw = e; }
    ok(threw && /presetFactory/.test(threw.message));
  });

  ctx.test('tools mode: forwards thinking deltas as chat:chunk kind=thinking', async () => {
    const { ToolRegistry } = require('../src/core/llm/tools/registry');
    const presetFactory = () => ({
      async *stream() {
        yield { type: 'thinking', text: 'pondering...' };
        yield { type: 'content', text: 'answer' };
        yield { type: 'done', totals: {} };
      },
    });
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: [] }),
      presetFactory,
      toolRegistry: new ToolRegistry(),
      tools: true,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('hi');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    const chunks = rec.events.filter((e) => e.name === 'chat:chunk').map((e) => e.payload);
    ok(chunks.some((c) => c.kind === 'thinking' && c.text === 'pondering...'));
    ok(chunks.some((c) => c.kind === 'text' && c.text === 'answer'));
  });

  ctx.test('tools mode: scope flows through to tool ctx', async () => {
    const { ToolRegistry } = require('../src/core/llm/tools/registry');
    const registry = new ToolRegistry();
    let seenCtx = null;
    registry.add({
      name: 'spy',
      run: async (_args, ctxArg) => { seenCtx = ctxArg; return { ok: true, content: 'ok' }; },
    });
    let turn = 0;
    const presetFactory = () => ({
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'spy', arguments: {} } };
          yield { type: 'done', totals: {} };
        } else {
          yield { type: 'content', text: 'done' };
          yield { type: 'done', totals: {} };
        }
      },
    });
    const fakeScope = { tag: 'scope-marker' };
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: [] }),
      presetFactory,
      toolRegistry: registry,
      tools: true,
      scope: fakeScope,
      cwd: '/some/cwd',
      onEvent: () => {},
    });
    await drv.start();
    drv.send('spy please');
    await eventually(() => ok(seenCtx), { msg: 'tool ctx received' });
    eq(seenCtx.scope, fakeScope);
    eq(seenCtx.cwd, '/some/cwd');
  });

  ctx.test('close before send rejects further sends', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['a'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    await drv.close();
    drv.send('hello');
    contains(rec.last('chat:error').payload.error, 'closed');
  });
};
