// OllamaCloudDriver tests. Stubs the runner with a scripted async
// generator and asserts the chat:* event sequence + memory-mirror
// payloads. Same shape as semanticDriver.test.js.

const {
  OllamaCloudDriver,
  OpenAICompatibleDriver,
  OPENROUTER_PROVIDER,
} = require('../src/core/drivers/openAICompatibleDriver');
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
    // Token-ledger contract: turn-end must carry provider so the
    // ledger knows which silo to record the usage under.
    eq(rec.last('chat:turn-end').payload.provider, 'ollama-cloud');
  });

  ctx.test('providerConfig parameterizes provider stamping + env vars (openrouter)', async () => {
    const rec = recorder();
    const savedKey = process.env.OPENROUTER_API_KEY;
    const savedModel = process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.OPENROUTER_MODEL = 'vendor/some-model';
    try {
      const drv = new OpenAICompatibleDriver({
        agentId: 'or1',
        providerConfig: OPENROUTER_PROVIDER,
        // no apiKey/model args → must fall back to OPENROUTER_* env
        runnerFactory: () => fakeRunner({ chunks: ['hi'] }),
        onEvent: rec.onEvent,
      });
      eq(drv.provider, 'openrouter');
      eq(drv.apiKey, 'or-key');
      eq(drv.model, 'vendor/some-model');
      await drv.start();
      drv.send('hello');
      await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
      eq(rec.last('chat:turn-end').payload.provider, 'openrouter');
    } finally {
      if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
      if (savedModel === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = savedModel;
    }
  });

  ctx.test('missing provider API key uses the provider-specific env name in the error', async () => {
    const rec = recorder();
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const drv = new OpenAICompatibleDriver({
        agentId: 'or2', apiKey: null,
        providerConfig: OPENROUTER_PROVIDER,
        runnerFactory: () => fakeRunner(),
        onEvent: rec.onEvent,
      });
      await drv.start();
      contains(rec.last('chat:error').payload.error, 'OPENROUTER_API_KEY');
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
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

  ctx.test('maxIterations: explicit arg wins over OLLAMA_MAX_ITERATIONS env', async () => {
    const saved = process.env.OLLAMA_MAX_ITERATIONS;
    process.env.OLLAMA_MAX_ITERATIONS = '7';
    try {
      const drv = new OllamaCloudDriver({
        agentId: 'a1',
        apiKey: 'k',
        runnerFactory: () => fakeRunner(),
        onEvent: () => {},
        maxIterations: 42,
      });
      eq(drv.maxIterations, 42);
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_MAX_ITERATIONS;
      else process.env.OLLAMA_MAX_ITERATIONS = saved;
    }
  });

  ctx.test('maxIterations: falls back to OLLAMA_MAX_ITERATIONS env', async () => {
    const saved = process.env.OLLAMA_MAX_ITERATIONS;
    process.env.OLLAMA_MAX_ITERATIONS = '17';
    try {
      const drv = new OllamaCloudDriver({
        agentId: 'a1',
        apiKey: 'k',
        runnerFactory: () => fakeRunner(),
        onEvent: () => {},
      });
      eq(drv.maxIterations, 17);
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_MAX_ITERATIONS;
      else process.env.OLLAMA_MAX_ITERATIONS = saved;
    }
  });

  ctx.test('maxIterations: undefined when no arg + no env (loop applies default)', async () => {
    const saved = process.env.OLLAMA_MAX_ITERATIONS;
    delete process.env.OLLAMA_MAX_ITERATIONS;
    try {
      const drv = new OllamaCloudDriver({
        agentId: 'a1',
        apiKey: 'k',
        runnerFactory: () => fakeRunner(),
        onEvent: () => {},
      });
      eq(drv.maxIterations, undefined);
    } finally {
      if (saved !== undefined) process.env.OLLAMA_MAX_ITERATIONS = saved;
    }
  });

  ctx.test('envContext: string is prepended once as system message', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'k',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
      envContext: '# Env\n- cwd: /x',
    });
    await drv.start();
    drv.send('one');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    drv.send('two');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 2));
    // exactly one system message, at index 0
    eq(drv.messages[0].role, 'system');
    contains(drv.messages[0].content, '# Env');
    eq(drv.messages.filter((m) => m.role === 'system').length, 1);
  });

  ctx.test('envContext: null/undefined => no system message injected', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'k',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('one');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    eq(drv.messages.filter((m) => m.role === 'system').length, 0);
  });

  ctx.test('envContext: function receives cwd/scope and is awaited', async () => {
    const rec = recorder();
    let received = null;
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'k',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
      cwd: '/some/cwd',
      envContext: async (opts) => { received = opts; return '# computed'; },
    });
    await drv.start();
    drv.send('hi');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    eq(received.cwd, '/some/cwd');
    contains(drv.messages[0].content, '# computed');
  });

  ctx.test('describeEnvContextSpec produces a readable label per spec kind', () => {
    const { _describeEnvContextSpec: d } = require('../src/core/drivers/openAICompatibleDriver');
    contains(d(null), 'disabled');
    contains(d(undefined), 'disabled');
    contains(d(false), 'disabled');
    contains(d(true), 'default');
    contains(d('hello there'), 'string');
    contains(d('hello there'), '11 chars');
    contains(d(function myFn() {}), 'function');
    contains(d(function myFn() {}), 'myFn');
    contains(d({ skipGit: true, header: 'x' }), 'object');
    contains(d({ skipGit: true, header: 'x' }), 'skipGit');
  });

  ctx.test('envContext: emits chat:env-context applied:true with content + bytes', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'k',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
      envContext: '# Env\n- cwd: /x',
    });
    await drv.start();
    drv.send('one');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    drv.send('two');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 2));
    // Emitted exactly once across multiple turns (latched on _envContextApplied).
    eq(rec.countOf('chat:env-context'), 1);
    const ev = rec.last('chat:env-context').payload;
    eq(ev.applied, true);
    eq(ev.bytes, Buffer.byteLength('# Env\n- cwd: /x', 'utf8'));
    contains(ev.content, '# Env');
  });

  ctx.test('envContext: emits applied:false when disabled', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'k',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('one');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    eq(rec.countOf('chat:env-context'), 1);
    const ev = rec.last('chat:env-context').payload;
    eq(ev.applied, false);
    eq(ev.reason, 'disabled');
  });

  ctx.test('envContext: emits applied:false when resolver throws', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'k',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
      envContext: () => { throw new Error('resolver broke'); },
    });
    await drv.start();
    drv.send('hi');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    const ev = rec.last('chat:env-context').payload;
    eq(ev.applied, false);
    eq(ev.reason, 'resolver-threw');
    contains(ev.error, 'resolver broke');
    // The system message was NOT inserted on the resolver failure.
    eq(drv.messages.filter((m) => m.role === 'system').length, 0);
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
    // Token-ledger contract: tools-mode turn-end must also stamp provider.
    eq(rec.last('chat:turn-end').payload.provider, 'ollama-cloud');
  });

  ctx.test('hooks (plain mode): a blocking hook stops the send and ends turn ok:false', async () => {
    const rec = recorder();
    let streamed = false;
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => ({
        capabilities: { thinking: 'never' }, think: false,
        async health() { return { ok: true }; },
        async setThink() { return { ok: true, think: false }; },
        async *stream() { streamed = true; yield 'must not run'; },
      }),
      // tools omitted => plain-chat path.
      hooks: [{ name: 'no-secrets', preLlm: () => ({ allow: false, reason: 'secret detected' }) }],
      envContext: false,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('my password is hunter2');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });

    eq(streamed, false, 'runner.stream must not be called when a hook blocks');
    const blocked = rec.last('chat:hook-blocked');
    ok(blocked, 'chat:hook-blocked fired');
    eq(blocked.payload.blockedBy, 'no-secrets');
    contains(blocked.payload.reason, 'secret detected');
    const end = rec.last('chat:turn-end').payload;
    eq(end.ok, false);
    eq(end.blocked, true);
    contains(end.error, 'secret detected');
  });

  ctx.test('hooks (tools mode): block on the tool re-entry gates the tool result', async () => {
    const { ToolRegistry } = require('../src/core/llm/tools/registry');
    const echo = require('../src/core/llm/tools/echo');
    const registry = new ToolRegistry();
    registry.add(echo);

    let turn = 0;
    const presetFactory = () => ({
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { message: 'leak' } } };
          yield { type: 'done', totals: {} };
        } else {
          // Should never be reached — the hook blocks iteration 2.
          yield { type: 'content', text: 'must not run' };
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
      envContext: false,
      hooks: [{ name: 'gate-tool-output', preLlm: ({ iteration }) => (iteration === 1 ? { allow: true } : { allow: false, reason: 'tool output blocked' }) }],
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('echo leak');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });

    // The first send ran (tool was called), the second (tool result) was blocked.
    eq(rec.countOf('chat:tool-call'), 1);
    eq(turn, 1, 'preset.stream called once; the re-entry was gated');
    const blocked = rec.last('chat:hook-blocked');
    ok(blocked, 'chat:hook-blocked fired on the re-entry');
    eq(blocked.payload.iteration, 2);
    const end = rec.last('chat:turn-end').payload;
    eq(end.ok, false);
    eq(end.blocked, true);
  });

  ctx.test('pre-tool hook: blocks the tool call but the turn continues (model recovers)', async () => {
    const { ToolRegistry } = require('../src/core/llm/tools/registry');
    const registry = new ToolRegistry();
    let toolRan = false;
    // A stand-in write tool: records whether it actually executed, so we can
    // assert the guardrail stopped it from reaching "disk".
    registry.add({
      name: 'write_file',
      description: 'write a file',
      parameters: { type: 'object', properties: { content: { type: 'string' } } },
      run: async (args) => { toolRan = true; return { ok: true, content: `wrote ${args.content}` }; },
    });

    let turn = 0;
    const presetFactory = () => ({
      async *stream() {
        turn += 1;
        if (turn === 1) {
          // Model tries to write a secret.
          yield { type: 'tool_call', call: { id: 'c1', name: 'write_file', arguments: { content: 'AKIA-SECRET' } } };
          yield { type: 'done', totals: {} };
        } else {
          // After seeing the refusal, the model gives up gracefully.
          yield { type: 'content', text: 'understood, not writing that' };
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
      envContext: false,
      hooks: [{
        name: 'no-secrets',
        preTool: ({ tool, args }) => (
          tool === 'write_file' && /AKIA/.test(JSON.stringify(args))
            ? { allow: false, reason: 'AWS access key id in write' }
            : { allow: true }
        ),
      }],
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('write my key');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });

    eq(toolRan, false, 'the write tool must NOT execute when the pre-tool hook blocks it');
    const tb = rec.last('chat:tool-blocked');
    ok(tb, 'chat:tool-blocked fired');
    eq(tb.payload.call.name, 'write_file');
    eq(tb.payload.blockedBy, 'no-secrets');
    contains(tb.payload.reason, 'AWS access key');
    // The turn is NOT aborted — the model re-entered and settled normally.
    eq(turn, 2, 'the loop re-entered after the block so the model could react');
    const end = rec.last('chat:turn-end').payload;
    eq(end.ok, true, 'a single blocked tool does not fail the whole turn');
    contains(end.assistantText, 'understood');
  });

  ctx.test('pre-tool hook: a worker with no preTool hooks runs the tool normally', async () => {
    const { ToolRegistry } = require('../src/core/llm/tools/registry');
    const registry = new ToolRegistry();
    let toolRan = false;
    registry.add({
      name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} },
      run: async () => { toolRan = true; return { ok: true, content: 'wrote' }; },
    });
    let turn = 0;
    const presetFactory = () => ({
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'write_file', arguments: {} } };
          yield { type: 'done', totals: {} };
        } else {
          yield { type: 'content', text: 'done' };
          yield { type: 'done', totals: {} };
        }
      },
    });
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: [] }),
      presetFactory, toolRegistry: registry, tools: true, envContext: false,
      // preLlm-only hook present: it must NOT gate the tool dispatch.
      hooks: [{ name: 'llm-only', preLlm: () => ({ allow: true }) }],
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(toolRan, true, 'tool runs when no preTool hook applies');
    eq(rec.countOf('chat:tool-blocked'), 0);
  });

  ctx.test('hooks: a worker with no hooks behaves exactly as before (no gating)', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1',
      apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['hello'] }),
      hooks: [],
      envContext: false,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('hi');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.countOf('chat:hook-blocked'), 0);
    eq(rec.last('chat:turn-end').payload.ok, true);
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

  // ---- /skill slash command --------------------------------------------

  // Minimal tool registry stub that mimics ToolRegistry's shape. We don't
  // need ToolUseLoop here — slash handling runs the tool directly.
  function makeRegistry(tools) {
    const map = new Map(tools.map((t) => [t.name, t]));
    return { get: (n) => map.get(n) || null, has: (n) => map.has(n), list: () => [...map.values()] };
  }
  function fakeSkillTool({ name, description = 'A test skill.', body = 'invoked!', shouldThrow = false }) {
    return {
      name, description,
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      async run(args) {
        if (shouldThrow) throw new Error('skill exploded');
        return { ok: true, content: `[skill] task=${args.task || ''} :: ${body}` };
      },
    };
  }

  ctx.test('/skill with no args lists registered skills', async () => {
    const rec = recorder();
    const registry = makeRegistry([
      fakeSkillTool({ name: 'skill_alpha', description: 'Does alpha things. Use for X.' }),
      fakeSkillTool({ name: 'skill_beta',  description: 'Does beta things.' }),
    ]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => ({}), toolRegistry: registry, tools: true,
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    const text = rec.last('chat:turn-end').payload.assistantText;
    contains(text, 'Available skills');
    contains(text, '/skill alpha');
    contains(text, '/skill beta');
    eq(rec.last('chat:turn-end').payload.ok, true);
    eq(rec.last('chat:turn-end').payload.provider, 'ollama-cloud');
  });

  ctx.test('/skill help is equivalent to /skill with no args', async () => {
    const rec = recorder();
    const registry = makeRegistry([
      fakeSkillTool({ name: 'skill_alpha', description: 'A.' }),
    ]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => ({}), toolRegistry: registry, tools: true,
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill help');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    contains(rec.last('chat:turn-end').payload.assistantText, 'Available skills');
  });

  ctx.test('/skill listing is graceful when none are registered', async () => {
    const rec = recorder();
    const registry = makeRegistry([]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => ({}), toolRegistry: registry, tools: true,
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    contains(rec.last('chat:turn-end').payload.assistantText, 'No skills registered');
  });

  // A registry that ALSO drives ToolUseLoop: dispatch() runs the tool and
  // toOpenAISchema() feeds the (ignored-by-stub) runner. The invoke path
  // now seeds the loop instead of running the tool directly, so these tests
  // need a real dispatch + a scripted preset that emits a tool_call.
  function makeLoopRegistry(tools) {
    const map = new Map(tools.map((t) => [t.name, t]));
    return {
      get: (n) => map.get(n) || null,
      has: (n) => map.has(n),
      list: () => [...map.values()],
      toOpenAISchema: () => [...map.values()].map((t) => ({
        type: 'function', function: { name: t.name, parameters: t.parameters || {} },
      })),
      async dispatch(call, dctx) {
        const tool = map.get(call.name);
        if (!tool) return { ok: false, content: `no such tool ${call.name}` };
        try { return await tool.run(call.arguments || {}, dctx); }
        catch (err) { return { ok: false, content: `tool threw: ${err.message}` }; }
      },
    };
  }

  // Scripted preset for the loop. Stateless-by-inspection so it survives
  // multiple turns sharing one preset instance: if the last message is a
  // fresh user turn (the seed), emit one tool_call for `toolName`; otherwise
  // (the post-dispatch history) emit a content turn so the loop terminates.
  // Captures the seed (first user message of each turn) for assertions.
  function scriptedSkillPreset(toolName, capture) {
    return {
      async *stream(messages /* , { signal, tools } */) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'user') {
          if (capture) capture.seed = last.content; // the seeded directive
          yield { type: 'tool_call', call: { id: 'c1', name: toolName, arguments: { task: capture?.task || '' } } };
          yield { type: 'done', totals: {} };
        } else {
          yield { type: 'content', text: 'skill done' };
          yield { type: 'done', totals: {} };
        }
      },
    };
  }

  ctx.test('/skill <name> seeds the loop and the model calls the skill tool', async () => {
    const rec = recorder();
    const cap = { task: '' };
    const registry = makeLoopRegistry([fakeSkillTool({ name: 'skill_alpha', body: 'A body' })]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
      toolRegistry: registry, tools: true, skillScopeGuard: false,
      skills: [{ name: 'alpha', dir: '/skills/alpha', mdPath: '/skills/alpha/SKILL.md' }],
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill alpha');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    // The model (not the driver) issued the tool call inside the loop.
    eq(rec.countOf('chat:tool-call'), 1);
    eq(rec.last('chat:tool-call').payload.call.name, 'skill_alpha');
    // The seed (a directive naming skill_alpha) reached the runner, not the raw "/skill alpha".
    contains(cap.seed, 'skill_alpha');
    eq(rec.last('chat:turn-end').payload.ok, true);
  });

  ctx.test('/skill <name> <task...> threads the task into the seed', async () => {
    const rec = recorder();
    const cap = { task: 'run the suite quickly' };
    const registry = makeLoopRegistry([fakeSkillTool({ name: 'skill_alpha' })]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
      toolRegistry: registry, tools: true, skillScopeGuard: false,
      skills: [{ name: 'alpha', dir: '/skills/alpha', mdPath: '/skills/alpha/SKILL.md' }],
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill alpha run the suite quickly');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    contains(cap.seed, 'run the suite quickly');
  });

  ctx.test('/<name> shorthand invokes the skill via the loop', async () => {
    const rec = recorder();
    const cap = { task: 'foo.md' };
    const registry = makeLoopRegistry([fakeSkillTool({ name: 'skill_alpha' })]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
      toolRegistry: registry, tools: true, skillScopeGuard: false,
      skills: [{ name: 'alpha', dir: '/skills/alpha', mdPath: '/skills/alpha/SKILL.md' }],
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/alpha foo.md');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.countOf('chat:tool-call'), 1);
    eq(rec.last('chat:tool-call').payload.call.name, 'skill_alpha');
    contains(cap.seed, 'foo.md');
  });

  ctx.test('/<name> for a reserved word (/help) falls through to the model', async () => {
    const rec = recorder();
    // skill_help is registered, but /help must NOT shorthand-invoke it.
    const registry = makeLoopRegistry([fakeSkillTool({ name: 'skill_help' })]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => ({}), toolRegistry: registry, tools: false,
      skills: [{ name: 'help', dir: '/skills/help', mdPath: '/skills/help/SKILL.md' }],
      runnerFactory: () => fakeRunner({ chunks: ['plain'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/help');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.countOf('chat:tool-call'), 0);
    eq(rec.last('chat:turn-end').payload.assistantText, 'plain');
  });

  ctx.test('/skill <unknown> returns a helpful error with the available list', async () => {
    const rec = recorder();
    const registry = makeRegistry([
      fakeSkillTool({ name: 'skill_alpha' }),
      fakeSkillTool({ name: 'skill_beta' }),
    ]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => ({}), toolRegistry: registry, tools: true,
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill nope');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.last('chat:turn-end').payload.ok, false);
    const text = rec.last('chat:turn-end').payload.assistantText;
    contains(text, 'No such skill');
    contains(text, 'alpha');
    contains(text, 'beta');
    // Unknown skill should NOT have emitted a tool-call/result.
    eq(rec.countOf('chat:tool-call'), 0);
    eq(rec.countOf('chat:tool-result'), 0);
  });

  ctx.test('/skill <name> when the skill tool throws -> loop surfaces ok:false tool-result, turn still ends cleanly', async () => {
    const rec = recorder();
    const cap = { task: '' };
    // dispatch() converts the throw into an ok:false result, the model sees
    // it and finishes; the turn ends ok (the loop completed) per ToolUseLoop.
    const registry = makeLoopRegistry([fakeSkillTool({ name: 'skill_alpha', shouldThrow: true })]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
      toolRegistry: registry, tools: true, skillScopeGuard: false,
      skills: [{ name: 'alpha', dir: '/skills/alpha', mdPath: '/skills/alpha/SKILL.md' }],
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill alpha');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.countOf('chat:tool-result'), 1);
    eq(rec.last('chat:tool-result').payload.result.ok, false);
    contains(rec.last('chat:tool-result').payload.result.content, 'skill exploded');
    eq(rec.last('chat:turn-end').payload.ok, true); // loop completed without throwing
  });

  ctx.test('non-/skill slash commands still flow to the model (not intercepted)', async () => {
    const rec = recorder();
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      runnerFactory: () => fakeRunner({ chunks: ['ok'] }),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/help');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    // Plain-mode path ran (no tool-call events, the runner stub yielded 'ok').
    eq(rec.countOf('chat:tool-call'), 0);
    eq(rec.last('chat:turn-end').payload.assistantText, 'ok');
  });

  ctx.test('back-to-back /skill calls do not wedge turnActive', async () => {
    const rec = recorder();
    const cap = { task: '' };
    const registry = makeLoopRegistry([fakeSkillTool({ name: 'skill_alpha' })]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      // Fresh scripted preset per turn so each turn's iteration counter resets.
      presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
      toolRegistry: registry, tools: true, skillScopeGuard: false,
      skills: [{ name: 'alpha', dir: '/skills/alpha', mdPath: '/skills/alpha/SKILL.md' }],
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill alpha first');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    drv.send('/skill alpha second');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 2));
    eq(rec.countOf('chat:tool-call'), 2);
    // Second turn's seed carried the "second" task.
    contains(cap.seed, 'second');
  });

  // ---- scope guard ------------------------------------------------------

  // A tool that records the ctx it was dispatched with, so we can assert the
  // guard pinned ctx.cwd and that the skill dir was in scope mid-turn.
  function ctxProbeTool(name, sink) {
    return {
      name,
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      async run(args, dctx) {
        sink.cwd = dctx.cwd;
        sink.inScopeMidTurn = dctx.scope && typeof dctx.scope.containsSync === 'function'
          ? dctx.scope.containsSync(sink.skillDir)
          : null;
        return { ok: true, content: 'probed' };
      },
    };
  }

  ctx.test('scope guard ON: skill dir added + bash cwd pinned mid-turn, reverted after', async () => {
    const { Scope } = require('../src/core/scope');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const skillDir = path.join(os.tmpdir(), `guard-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(skillDir, { recursive: true });
    try {
      const rec = recorder();
      const cap = { task: '' };
      const sink = { skillDir };
      const scope = new Scope([os.tmpdir() + path.sep + 'unrelated']); // skillDir NOT covered
      const registry = makeLoopRegistry([ctxProbeTool('skill_alpha', sink)]);
      const drv = new OllamaCloudDriver({
        agentId: 'a1', apiKey: 'fake-key',
        presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
        toolRegistry: registry, tools: true,
        skillScopeGuard: true, scope,
        skills: [{ name: 'alpha', dir: skillDir, mdPath: path.join(skillDir, 'SKILL.md') }],
        runnerFactory: () => fakeRunner(),
        onEvent: rec.onEvent,
      });
      await drv.start();
      drv.send('/skill alpha');
      await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
      // Mid-turn: dir reachable + bash cwd pinned to it.
      eq(sink.inScopeMidTurn, true);
      eq(require('fs').realpathSync(sink.cwd), require('fs').realpathSync(skillDir));
      // After the turn: reverted (we added it, so it is removed).
      eq(scope.containsSync(skillDir), false);
    } finally { fs.rmSync(skillDir, { recursive: true, force: true }); }
  });

  ctx.test('scope guard OFF: no scope mutation, bash cwd stays the worker cwd', async () => {
    const { Scope } = require('../src/core/scope');
    const rec = recorder();
    const cap = { task: '' };
    const sink = { skillDir: '/skills/alpha' };
    const scope = new Scope(['/worker/cwd']);
    const before = scope.list();
    const registry = makeLoopRegistry([ctxProbeTool('skill_alpha', sink)]);
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => scriptedSkillPreset('skill_alpha', cap),
      toolRegistry: registry, tools: true,
      skillScopeGuard: false, scope, cwd: '/worker/cwd',
      skills: [{ name: 'alpha', dir: '/skills/alpha', mdPath: '/skills/alpha/SKILL.md' }],
      runnerFactory: () => fakeRunner(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('/skill alpha');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(sink.cwd, '/worker/cwd'); // not pinned to the skill dir
    require('./assert').deepEq(scope.list(), before, 'scope unchanged');
  });

  ctx.test('skillScopeGuard defaults ON when not specified', async () => {
    const drv = new OllamaCloudDriver({
      agentId: 'a1', apiKey: 'fake-key',
      presetFactory: () => ({}), toolRegistry: makeRegistry([]), tools: true,
      runnerFactory: () => fakeRunner(),
      onEvent: () => {},
    });
    eq(drv.skillScopeGuard, true);
  });
};
