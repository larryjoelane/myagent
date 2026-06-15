// ClaudeDriver tests. Replay captured stream-json fixtures through a
// fake subprocess and assert the driver emits the right chat:* events.
//
// Fixtures live in tests/fixtures/claude-events/ and were captured by
// running real claude during the headless-mode probe.

const path = require('path');
const { ClaudeDriver } = require('../src/core/drivers/claudeDriver');
const { makeFake, replayFixture } = require('./helpers/fakeSubprocess');
const { eq, ok, contains, eventually } = require('./assert');

const FIXTURES = path.resolve(__dirname, 'fixtures', 'claude-events');

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
    chunks() { return events.filter((e) => e.name === 'chat:chunk'); },
  };
}

function run(t) {

  t.test('single text-only turn produces user/turn-start/chunk/turn-end', async () => {
    const r = recorder();
    const driver = new ClaudeDriver({
      agentId: 'a',
      onEvent: r.onEvent,
      spawnFn: replayFixture(path.join(FIXTURES, '01-simple.jsonl')),
    });
    await driver.start();
    driver.send('say hello in five words');
    await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 3000 });
    eq(r.events[0].name, 'chat:user', 'first event is chat:user');
    eq(r.events[0].payload.text, 'say hello in five words', 'user text preserved');
    eq(r.events[1].name, 'chat:turn-start', 'second is chat:turn-start');
    const end = r.last('chat:turn-end');
    ok(end, 'turn-end fired');
    eq(end.payload.ok, true, 'turn ended ok');
    contains(end.payload.assistantText, 'Hello there', 'assistant text in payload');
    ok(end.payload.totals && typeof end.payload.totals.costUsd === 'number', 'cost reported');
    await driver.close();
  });

  t.test('tool-use blocks emit kind=tool-use chunks with structured payload', async () => {
    const r = recorder();
    const driver = new ClaudeDriver({
      agentId: 't',
      onEvent: r.onEvent,
      spawnFn: replayFixture(path.join(FIXTURES, '02-tool-call.jsonl')),
    });
    await driver.start();
    driver.send('list files');
    await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 3000 });
    const toolUse = r.chunks().find((c) => c.payload.kind === 'tool-use');
    ok(toolUse, 'tool-use chunk emitted');
    eq(toolUse.payload.name, 'Bash', 'tool name = Bash');
    ok(toolUse.payload.input && toolUse.payload.input.command, 'tool input.command present');
    ok(toolUse.payload.toolUseId, 'tool_use id propagated');
    const toolResult = r.chunks().find((c) => c.payload.kind === 'tool-result');
    ok(toolResult, 'tool-result chunk emitted');
    eq(toolResult.payload.toolUseId, toolUse.payload.toolUseId, 'tool_use_id matches across use+result');
    eq(toolResult.payload.isError, false, 'tool result not flagged error');
    await driver.close();
  });

  t.test('permission denial surfaces as is_error tool-result + assistant explanation', async () => {
    const r = recorder();
    const driver = new ClaudeDriver({
      agentId: 'p',
      onEvent: r.onEvent,
      spawnFn: replayFixture(path.join(FIXTURES, '05-write-permission.jsonl')),
    });
    await driver.start();
    driver.send('write a file');
    await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 3000 });
    const toolResult = r.chunks().find((c) => c.payload.kind === 'tool-result');
    ok(toolResult, 'tool-result chunk emitted');
    eq(toolResult.payload.isError, true, 'tool-result flagged is_error');
    contains(String(toolResult.payload.content || ''), 'permissions', 'denial message mentions permissions');
    const end = r.last('chat:turn-end');
    ok(end.payload.totals.permissionDenials.length > 0, 'permission_denials surfaced in totals');
    eq(end.payload.totals.permissionDenials[0].tool_name, 'Write', 'denial includes tool name');
    await driver.close();
  });

  t.test('long-running session: two send() calls produce two turn-ends', async () => {
    // We can't just replay one fixture for this — multi-turn needs
    // events to come in response to BOTH user messages. So we drive
    // a fake manually.
    const r = recorder();
    const { proc, controls } = makeFake();
    const driver = new ClaudeDriver({
      agentId: 'm',
      onEvent: r.onEvent,
      spawnFn: () => proc,
    });
    await driver.start();

    driver.send('first');
    // simulate claude responding to first
    controls.pushLine({
      type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '.', tools: [], model: 'claude-opus-4-7',
    });
    controls.pushLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'first reply' }] },
    });
    controls.pushLine({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 100, num_turns: 1, total_cost_usd: 0.01,
      result: 'first reply', stop_reason: 'end_turn', permission_denials: [],
    });
    await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 1500 });

    driver.send('second');
    controls.pushLine({
      type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '.', tools: [], model: 'claude-opus-4-7',
    });
    controls.pushLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'second reply' }] },
    });
    controls.pushLine({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 100, num_turns: 1, total_cost_usd: 0.01,
      result: 'second reply', stop_reason: 'end_turn', permission_denials: [],
    });
    await eventually(() => r.countOf('chat:turn-end') === 2, { timeoutMs: 1500 });

    const ends = r.events.filter((e) => e.name === 'chat:turn-end');
    contains(ends[0].payload.assistantText, 'first reply');
    contains(ends[1].payload.assistantText, 'second reply');
    await driver.close();
  });

  t.test('crash mid-turn finalizes the open turn with ok=false', async () => {
    const r = recorder();
    const { proc, controls } = makeFake();
    const driver = new ClaudeDriver({
      agentId: 'c',
      onEvent: r.onEvent,
      spawnFn: () => proc,
    });
    await driver.start();
    driver.send('do something');
    // Send a partial assistant response, then crash before result.
    controls.pushLine({
      type: 'system', subtype: 'init', session_id: 'sess-c', cwd: '.', tools: [], model: 'claude-opus-4-7',
    });
    controls.pushLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I started' }] },
    });
    controls.exit(1, null);
    await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 1500 });
    const end = r.last('chat:turn-end');
    eq(end.payload.ok, false, 'turn marked not ok');
    contains(end.payload.assistantText, 'I started', 'partial assistant text preserved');
    ok(r.last('chat:driver-exit'), 'driver-exit event fired');
  });

  t.test('send() while turn active emits chat:error and is rejected', async () => {
    const r = recorder();
    const { proc, controls } = makeFake();
    const driver = new ClaudeDriver({
      agentId: 'b',
      onEvent: r.onEvent,
      spawnFn: () => proc,
    });
    await driver.start();
    driver.send('one');
    driver.send('two'); // should error — turn one still active
    const errs = r.events.filter((e) => e.name === 'chat:error');
    eq(errs.length, 1, 'single error fired');
    contains(errs[0].payload.error, 'in progress');
    // Clean up.
    controls.pushLine({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 1, num_turns: 1, total_cost_usd: 0,
      result: '', stop_reason: 'end_turn', permission_denials: [],
    });
    controls.exit(0);
    await driver.close();
  });

  t.test('non-JSON stdout lines are tolerated and skipped', async () => {
    const r = recorder();
    const { proc, controls } = makeFake();
    const driver = new ClaudeDriver({
      agentId: 'g',
      onEvent: r.onEvent,
      spawnFn: () => proc,
    });
    await driver.start();
    driver.send('hi');
    controls.pushStdout('this is not json\n');
    controls.pushStdout('also not json: {broken\n');
    controls.pushLine({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reply' }] },
    });
    controls.pushLine({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 1, num_turns: 1, total_cost_usd: 0, result: 'reply',
      stop_reason: 'end_turn', permission_denials: [],
    });
    await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 1500 });
    contains(r.last('chat:turn-end').payload.assistantText, 'reply',
      'driver recovered from garbage and processed valid lines');
    await driver.close();
  });
}

module.exports = { run };
