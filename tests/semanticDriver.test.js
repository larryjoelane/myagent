// SemanticDriver tests. Driver lifecycle, event contract, and the
// router/toolkit integration. Uses a fake router so we can deterministically
// drive the "matched"/"no match"/"tool throws" paths.

const { SemanticDriver, parseSlash, extractExplainFlag, formatToolHelp, formatGlobalHelp } = require('../src/core/drivers/semanticDriver');
const { ToolKit } = require('../src/core/semantic/toolkit');
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

// Build a router that returns a scripted result. For "miss" cases pass
// { toolId: null, candidates: [...] }.
function fakeRouter(result) {
  return { pick: async () => result };
}

function makeTool(id, name, runImpl) {
  return { id, name, description: `${id} desc`, run: runImpl };
}

exports.run = (ctx) => {
  ctx.test('start + close emit driver-exit', async () => {
    const rec = recorder();
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: null, candidates: [] }),
      toolkit: new ToolKit(),
      onEvent: rec.onEvent,
    });
    await drv.start();
    await drv.close();
    ok(rec.last('chat:driver-exit'), 'expected chat:driver-exit on close');
  });

  ctx.test('send before start emits chat:error', async () => {
    const rec = recorder();
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: null }),
      toolkit: new ToolKit(),
      onEvent: rec.onEvent,
    });
    drv.send('hello');
    contains(rec.last('chat:error').payload.error, 'not started');
  });

  ctx.test('matched tool runs and emits the proper sequence', async () => {
    const rec = recorder();
    const kit = new ToolKit([makeTool('echo', 'Echo', async ({ input }) => ({ ok: true, text: `you said: ${input}` }))]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'echo', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('hello');
    await eventually(() => ok(rec.last('chat:turn-end')), { msg: 'turn-end' });
    eq(rec.countOf('chat:user'), 1);
    eq(rec.countOf('chat:turn-start'), 1);
    eq(rec.countOf('chat:chunk'), 1);
    eq(rec.countOf('chat:turn-end'), 1);
    contains(rec.last('chat:chunk').payload.text, 'you said: hello');
    contains(rec.last('chat:chunk').payload.text, '[Echo]');
    eq(rec.last('chat:turn-end').payload.ok, true);
    eq(rec.last('chat:turn-end').payload.totals.toolId, 'echo');
  });

  ctx.test('no match produces a candidates summary, ok=true', async () => {
    const rec = recorder();
    const kit = new ToolKit([
      makeTool('a', 'A', async () => ({ ok: true, text: 'a' })),
      makeTool('b', 'B', async () => ({ ok: true, text: 'b' })),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({
        toolId: null,
        score: 0.1,
        reason: 'top score 0.100 below threshold 0.4',
        candidates: [
          { toolId: 'a', score: 0.10 },
          { toolId: 'b', score: 0.05 },
        ],
      }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('whatever');
    await eventually(() => ok(rec.last('chat:turn-end')));
    const chunk = rec.last('chat:chunk').payload;
    contains(chunk.text, 'No tool matched');
    contains(chunk.text, 'A');
    contains(chunk.text, 'B');
    eq(rec.last('chat:turn-end').payload.ok, true);
  });

  ctx.test('tool that throws produces ok=false turn-end with error', async () => {
    const rec = recorder();
    const kit = new ToolKit([
      makeTool('boom', 'Boom', async () => { throw new Error('kaboom'); }),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'boom', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('hi');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(rec.last('chat:turn-end').payload.ok, false);
    contains(rec.last('chat:turn-end').payload.assistantText, 'kaboom');
  });

  ctx.test('overlapping send() while turn is active emits chat:error', async () => {
    const rec = recorder();
    let resolveTool;
    const block = new Promise((r) => { resolveTool = r; });
    const kit = new ToolKit([
      makeTool('slow', 'Slow', async () => { await block; return { ok: true, text: 'done' }; }),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'slow', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('one');
    drv.send('two');
    contains(rec.last('chat:error').payload.error, 'previous turn');
    resolveTool();
    await eventually(() => ok(rec.last('chat:turn-end')));
  });

  ctx.test('tool returning a bare string is normalized to ok=true', async () => {
    const rec = recorder();
    const kit = new ToolKit([makeTool('s', 'S', async () => 'just a string')]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 's', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')));
    contains(rec.last('chat:chunk').payload.text, 'just a string');
    eq(rec.last('chat:turn-end').payload.ok, true);
  });

  ctx.test('close mid-turn emits a turn-end so callers do not hang', async () => {
    const rec = recorder();
    let resolveTool;
    const block = new Promise((r) => { resolveTool = r; });
    const kit = new ToolKit([makeTool('slow', 'Slow', async () => { await block; return 'x'; })]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'slow', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('go');
    await drv.close();
    ok(rec.last('chat:turn-end'), 'expected synthetic turn-end on close');
    eq(rec.last('chat:turn-end').payload.ok, false);
    resolveTool();
  });

  // ---- Slash commands (router bypass) ----------------------------------

  ctx.test('parseSlash recognizes /cmd and /cmd args', () => {
    eq(parseSlash('/help')?.cmd, 'help');
    eq(parseSlash('/help')?.args, '');
    eq(parseSlash('/grep WorkerManager')?.cmd, 'grep');
    eq(parseSlash('/grep WorkerManager')?.args, 'WorkerManager');
    eq(parseSlash('/git-log last 5 commits')?.args, 'last 5 commits');
  });

  ctx.test('parseSlash returns null for non-slash input', () => {
    eq(parseSlash(''), null);
    eq(parseSlash('hello'), null);
    eq(parseSlash('see /etc/passwd'), null); // leading whitespace/text disqualifies
    eq(parseSlash(' /grep'), null);
  });

  ctx.test('/help lists all tools without invoking the router', async () => {
    const rec = recorder();
    let routerCalls = 0;
    const router = { pick: async () => { routerCalls++; return { toolId: null }; } };
    const kit = new ToolKit([
      makeTool('alpha', 'Alpha', async () => ({ ok: true, text: 'a' })),
      makeTool('beta', 'Beta', async () => ({ ok: true, text: 'b' })),
    ]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/help');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(routerCalls, 0, 'router should not be consulted on /help');
    const chunk = rec.last('chat:chunk').payload;
    eq(chunk.kind, 'semantic-help');
    contains(chunk.text, 'Alpha');
    contains(chunk.text, 'Beta');
  });

  ctx.test('/<id> emits ONE chunk (the tool result), not a leading "Slash" chunk', async () => {
    // Regression: an earlier version emitted a chat:chunk with the
    // slash reply text BEFORE handing off to _runTool, producing an
    // empty/duplicate "Slash" card in the renderer.
    const rec = recorder();
    const router = { pick: async () => ({ toolId: 'wrong' }) };
    const kit = new ToolKit([
      makeTool('memory-search', 'Memory Search', async () => ({ ok: true, text: 'real result' })),
    ]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/memory-search lens thickness');
    await eventually(() => ok(rec.last('chat:turn-end')));
    // Exactly one chunk: the tool result. No prefix "semantic-slash"
    // chunk that would render as an empty card.
    eq(rec.countOf('chat:chunk'), 1, 'expected exactly one chunk');
    const chunk = rec.last('chat:chunk').payload;
    eq(chunk.kind, 'semantic-tool-result');
    contains(chunk.text, 'real result');
  });

  ctx.test('/help still emits its single help chunk (regression guard for slash refactor)', async () => {
    const rec = recorder();
    const router = { pick: async () => ({ toolId: null }) };
    const kit = new ToolKit([makeTool('a', 'A', async () => ({ ok: true, text: 'a' }))]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/help');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(rec.countOf('chat:chunk'), 1, '/help emits one chunk');
    eq(rec.last('chat:chunk').payload.kind, 'semantic-help');
  });

  ctx.test('/<id> bypasses router and runs that tool directly', async () => {
    const rec = recorder();
    let routerCalls = 0;
    const router = { pick: async () => { routerCalls++; return { toolId: 'wrong' }; } };
    let received = null;
    const kit = new ToolKit([
      makeTool('grep', 'Grep', async ({ input }) => { received = input; return { ok: true, text: `searched: ${input}` }; }),
    ]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/grep WorkerManager');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(routerCalls, 0, 'router should be bypassed');
    eq(received, 'WorkerManager');
    contains(rec.last('chat:turn-end').payload.assistantText, 'searched: WorkerManager');
  });

  ctx.test('/<id> --help prints that tool\'s help block', async () => {
    const rec = recorder();
    const router = { pick: async () => ({ toolId: null }) };
    const tool = makeTool('grep', 'Grep', async () => ({ ok: true, text: 'should not run' }));
    tool.usage = ['/grep foo', '/grep "spaces inside"'];
    const kit = new ToolKit([tool]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/grep --help');
    await eventually(() => ok(rec.last('chat:turn-end')));
    const chunk = rec.last('chat:chunk').payload;
    eq(chunk.kind, 'semantic-help');
    contains(chunk.text, '/grep foo');
    contains(chunk.text, 'spaces inside');
    // The tool itself must NOT have run.
    contains(rec.last('chat:turn-end').payload.assistantText, '/grep foo');
  });

  ctx.test('/help <id> shows that one tool\'s usage', async () => {
    const rec = recorder();
    const router = { pick: async () => ({ toolId: null }) };
    const tool = makeTool('grep', 'Grep', async () => ({ ok: true, text: 'x' }));
    tool.usage = ['/grep alpha'];
    const kit = new ToolKit([tool]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/help grep');
    await eventually(() => ok(rec.last('chat:turn-end')));
    contains(rec.last('chat:chunk').payload.text, '/grep alpha');
  });

  ctx.test('/<unknown> returns a helpful error listing known tools', async () => {
    const rec = recorder();
    const router = { pick: async () => ({ toolId: null }) };
    const kit = new ToolKit([makeTool('grep', 'Grep', async () => ({ ok: true, text: 'x' }))]);
    const drv = new SemanticDriver({ agentId: 'a1', router, toolkit: kit, onEvent: rec.onEvent });
    await drv.start();
    drv.send('/nonsense args');
    await eventually(() => ok(rec.last('chat:turn-end')));
    const chunk = rec.last('chat:chunk').payload;
    contains(chunk.text, 'Unknown slash command');
    contains(chunk.text, '/grep');
    eq(rec.last('chat:turn-end').payload.ok, false);
  });

  ctx.test('formatToolHelp falls back to a generic stub when usage is missing', () => {
    const tool = { id: 'plain', name: 'Plain', description: 'Does a thing.', run: async () => ({}) };
    const help = formatToolHelp(tool);
    contains(help, '/plain');
    contains(help, 'free-form input');
  });

  ctx.test('formatGlobalHelp summarizes every tool', () => {
    const tools = [
      { id: 'a', name: 'A', description: 'A is a tool. More text.' },
      { id: 'b', name: 'B', description: 'B is another. More.' },
    ];
    const help = formatGlobalHelp(tools);
    contains(help, '/a');
    contains(help, '/b');
    contains(help, 'A is a tool');
    contains(help, 'B is another');
  });

  // ---- Explain (--explain / generator integration) --------------------

  ctx.test('extractExplainFlag finds and strips the flags', () => {
    eq(extractExplainFlag('hello world').explain, null);
    eq(extractExplainFlag('hello world --explain').explain, true);
    eq(extractExplainFlag('hello world --explain').text, 'hello world');
    eq(extractExplainFlag('--no-explain hello').explain, false);
    eq(extractExplainFlag('--no-explain hello').text, 'hello');
    eq(extractExplainFlag('left --explain right').text, 'left right');
  });

  ctx.test('--explain triggers generator.generate after tool runs', async () => {
    const rec = recorder();
    let genCalled = 0;
    let promptSeen = '';
    const generator = {
      generate: async (prompt, opts, onToken) => {
        genCalled++;
        promptSeen = prompt;
        if (typeof onToken === 'function') {
          onToken({ token: 'It', cumulativeText: 'It', index: 1 });
          onToken({ token: ' worked.', cumulativeText: 'It worked.', index: 2 });
        }
        return { text: 'It worked.' };
      },
      modelId: 'mock-gen',
      defaultExplain: false,
    };
    const kit = new ToolKit([
      makeTool('grep', 'Grep', async () => ({ ok: true, text: 'one match in foo.js' })),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'grep', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
      generator,
    });
    await drv.start();
    drv.send('find Foo --explain');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(genCalled, 1, 'generator.generate called exactly once');
    contains(promptSeen, 'one match in foo.js');
    // Two explain chunks (the streamed tokens) plus the original
    // tool-result chunk.
    const explainChunks = rec.events.filter((e) =>
      e.name === 'chat:chunk' && e.payload.kind === 'semantic-explain');
    eq(explainChunks.length, 2);
    contains(rec.last('chat:turn-end').payload.assistantText, 'It worked.');
  });

  ctx.test('--no-explain wins over generator.defaultExplain=true', async () => {
    const rec = recorder();
    let genCalled = 0;
    const generator = {
      generate: async () => { genCalled++; return { text: 'nope' }; },
      modelId: 'mock-gen',
      defaultExplain: true,
    };
    const kit = new ToolKit([
      makeTool('grep', 'Grep', async () => ({ ok: true, text: 'x' })),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'grep', score: 0.9, candidates: [] }),
      toolkit: kit, onEvent: rec.onEvent, generator,
    });
    await drv.start();
    drv.send('find x --no-explain');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(genCalled, 0, 'generator skipped despite defaultExplain');
  });

  ctx.test('generator failure surfaces as semantic-explain-error, tool result still ok', async () => {
    const rec = recorder();
    const generator = {
      generate: async () => { throw new Error('model exploded'); },
      modelId: 'mock-gen',
      defaultExplain: true,
    };
    const kit = new ToolKit([
      makeTool('grep', 'Grep', async () => ({ ok: true, text: 'tool output' })),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'grep', score: 0.9, candidates: [] }),
      toolkit: kit, onEvent: rec.onEvent, generator,
    });
    await drv.start();
    drv.send('find x');   // defaultExplain true → tries to explain
    await eventually(() => ok(rec.last('chat:turn-end')));
    const err = rec.events.find((e) =>
      e.name === 'chat:chunk' && e.payload.kind === 'semantic-explain-error');
    ok(err, 'expected semantic-explain-error chunk');
    contains(err.payload.text, 'model exploded');
    // Turn still completes, tool result still in assistantText.
    eq(rec.last('chat:turn-end').payload.ok, true);
    contains(rec.last('chat:turn-end').payload.assistantText, 'tool output');
  });

  ctx.test('no generator + --explain = no error, no extra chunks', async () => {
    const rec = recorder();
    const kit = new ToolKit([
      makeTool('grep', 'Grep', async () => ({ ok: true, text: 'x' })),
    ]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'grep', score: 0.9, candidates: [] }),
      toolkit: kit, onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('find x --explain');
    await eventually(() => ok(rec.last('chat:turn-end')));
    // Just the one tool-result chunk; --explain is silently dropped
    // when no generator is configured.
    eq(rec.events.filter((e) => e.name === 'chat:chunk').length, 1);
  });

  ctx.test('empty/whitespace send is ignored (no events emitted)', async () => {
    const rec = recorder();
    const kit = new ToolKit([makeTool('e', 'E', async () => 'e')]);
    const drv = new SemanticDriver({
      agentId: 'a1',
      router: fakeRouter({ toolId: 'e', score: 0.9, candidates: [] }),
      toolkit: kit,
      onEvent: rec.onEvent,
    });
    await drv.start();
    drv.send('   ');
    eq(rec.countOf('chat:user'), 0);
    eq(rec.countOf('chat:turn-start'), 0);
  });
};
