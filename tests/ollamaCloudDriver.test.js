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
