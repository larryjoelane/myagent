// Live tests against real claude. These actually invoke `claude` as
// a subprocess, so they:
//   - cost a few cents per run
//   - require claude on PATH and authenticated
//   - take 5-15 seconds total
//
// Default: ON. Skip with MYAGENT_SKIP_LIVE=1 (CI without claude
// access, fast iteration loops, offline work).
//
// Purpose: catch schema drift in claude's stream-json output. The
// fast fixture-replay tests (claudeDriver.test.js) will keep passing
// even if Anthropic changes the event format — these don't.

const { ClaudeDriver } = require('../src/core/drivers/claudeDriver');
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
    chunks() { return events.filter((e) => e.name === 'chat:chunk'); },
  };
}

function run(t) {
  const skipped = process.env.MYAGENT_SKIP_LIVE === '1';
  if (skipped) {
    t.test('SKIP live tests (MYAGENT_SKIP_LIVE=1)', async () => {
      // No-op: surfaces the skip in runner output.
    });
    return;
  }

  t.test('LIVE: single-turn echo against real claude', async () => {
    const r = recorder();
    const driver = new ClaudeDriver({ agentId: 'live-1', onEvent: r.onEvent });
    try {
      await driver.start();
      driver.send('respond with exactly the words: alpha bravo charlie');
      await eventually(() => r.countOf('chat:turn-end') === 1, {
        timeoutMs: 60_000,
        msg: 'real claude turn-end',
      });
      const end = r.last('chat:turn-end');
      ok(end.payload.ok, 'turn ok');
      // Don't assert exact text — claude phrasing varies. Assert
      // structure: assistant text non-empty, totals populated.
      ok(end.payload.assistantText && end.payload.assistantText.trim().length > 0,
        'assistant text non-empty');
      ok(end.payload.totals && typeof end.payload.totals.costUsd === 'number',
        'totals.costUsd is a number — schema unchanged');
      ok(end.payload.totals.numTurns >= 1, 'totals.numTurns populated');
      ok(Array.isArray(end.payload.totals.permissionDenials),
        'totals.permissionDenials is array — schema unchanged');
      // We also expect at least one text chunk to have streamed.
      const textChunks = r.chunks().filter((c) => c.payload.kind === 'text');
      ok(textChunks.length >= 1, 'at least one text chunk emitted');
    } finally {
      await driver.close();
    }
  });

  t.test('LIVE: tool-use against real claude (Bash)', async () => {
    const r = recorder();
    const driver = new ClaudeDriver({ agentId: 'live-2', onEvent: r.onEvent });
    try {
      await driver.start();
      driver.send('run "echo hello-from-live-test" using bash and report what it printed');
      await eventually(() => r.countOf('chat:turn-end') === 1, {
        timeoutMs: 90_000,
        msg: 'tool-use turn-end',
      });
      const end = r.last('chat:turn-end');
      ok(end.payload.ok, 'turn ok');
      const toolUse = r.chunks().find((c) => c.payload.kind === 'tool-use');
      ok(toolUse, 'tool-use chunk emitted');
      // Don't pin to exact tool name — claude might pick Bash, PowerShell,
      // or a Skill. Assert the structural shape we depend on.
      ok(toolUse.payload.name && typeof toolUse.payload.name === 'string',
        'tool-use has name field — schema unchanged');
      ok(toolUse.payload.input && typeof toolUse.payload.input === 'object',
        'tool-use has input object — schema unchanged');
      ok(toolUse.payload.toolUseId, 'tool-use has toolUseId — schema unchanged');

      const toolResult = r.chunks().find((c) =>
        c.payload.kind === 'tool-result' && c.payload.toolUseId === toolUse.payload.toolUseId);
      ok(toolResult, 'matching tool-result chunk emitted');
      eq(typeof toolResult.payload.isError, 'boolean',
        'tool-result has isError boolean — schema unchanged');
    } finally {
      await driver.close();
    }
  });
}

module.exports = { run };
