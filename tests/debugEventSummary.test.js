// Tests for the pure event-summary helpers used by <debug-drawer>.
// renderer/components/debugEventSummary.js is ESM; load via dynamic
// import (the runner re-execs under Electron so import() works).

const { eq, ok, contains } = require('./assert');

let mod;
async function load() {
  if (!mod) mod = await import('../renderer/components/debugEventSummary.js');
  return mod;
}

function run(ctx) {
  ctx.test('eventTag strips chat: prefix and tolerates unknown shapes', async () => {
    const { eventTag } = await load();
    eq(eventTag('chat:tool-call'), 'tool-call');
    eq(eventTag('chat:user'), 'user');
    eq(eventTag('weird'), 'weird');
    eq(eventTag(null), '?');
    eq(eventTag(undefined), '?');
  });

  ctx.test('summarize: user echoes truncated text', async () => {
    const { summarize } = await load();
    eq(summarize('chat:user', { text: 'hello' }), 'hello');
    const long = 'x'.repeat(500);
    const out = summarize('chat:user', { text: long });
    ok(out.length <= 120);
    ok(out.endsWith('…'));
  });

  ctx.test('summarize: tool-call picks the right key per tool', async () => {
    const { summarize } = await load();
    eq(summarize('chat:tool-call', {
      call: { name: 'bash', arguments: { command: 'npm install' } },
    }), 'bash(command=npm install)');
    eq(summarize('chat:tool-call', {
      call: { name: 'read_file', arguments: { path: 'src/foo.js' } },
    }), 'read_file(path=src/foo.js)');
    eq(summarize('chat:tool-call', {
      call: { name: 'edit', arguments: { file_path: 'a.js', old_string: 'x', new_string: 'y' } },
    }), 'edit(file_path=a.js)');
    eq(summarize('chat:tool-call', {
      call: { name: 'grep', arguments: { pattern: 'foo', path: 'src' } },
    }), 'grep(pattern=foo, path=src)');
  });

  ctx.test('summarize: tool-call with unknown tool falls back to JSON', async () => {
    const { summarize } = await load();
    const out = summarize('chat:tool-call', {
      call: { name: 'mystery', arguments: { a: 1, b: 'two' } },
    });
    eq(out, 'mystery({"a":1,"b":"two"})');
  });

  ctx.test('summarize: tool-result shows ok/ERR + bytes + content head', async () => {
    const { summarize } = await load();
    eq(summarize('chat:tool-result', {
      call: { name: 'bash' },
      result: { ok: true, content: 'hello' },
    }), 'bash ok 5b · hello');
    const errOut = summarize('chat:tool-result', {
      call: { name: 'edit' },
      result: { ok: false, content: 'edit: not found' },
    });
    contains(errOut, 'edit ERR');
    contains(errOut, 'not found');
  });

  ctx.test('summarize: turn-end shows iterations/model/hit-max/err', async () => {
    const { summarize } = await load();
    eq(summarize('chat:turn-end', {
      ok: true, totals: { iterations: 3, model: 'ministral-3:3b-cloud' },
    }), 'ok · iter=3 · ministral-3:3b-cloud');
    contains(summarize('chat:turn-end', {
      ok: true, totals: { iterations: 30 }, hitMaxIterations: true,
    }), 'HIT-MAX');
    contains(summarize('chat:turn-end', {
      ok: false, totals: {}, error: 'aborted',
    }), 'ERR');
  });

  ctx.test('chipClass returns a recognizable CSS class per event', async () => {
    const { chipClass } = await load();
    eq(chipClass('chat:tool-call'), 'debug-chip--tool-call');
    eq(chipClass('chat:error'), 'debug-chip--error');
    eq(chipClass('chat:unknown'), 'debug-chip--other');
  });

  ctx.test('summarize: error event surfaces error message', async () => {
    const { summarize } = await load();
    eq(summarize('chat:error', { error: 'boom' }), 'boom');
    eq(summarize('chat:error', {}), '(no message)');
  });

  ctx.test('summarize: chunk shows kind tag and text head', async () => {
    const { summarize } = await load();
    contains(summarize('chat:chunk', { kind: 'text', text: 'hello world' }), '[text]');
    contains(summarize('chat:chunk', { kind: 'thinking', text: 'reasoning…' }), '[thinking]');
  });

  ctx.test('summarize: env-context applied shows bytes + tool count', async () => {
    const { summarize } = await load();
    eq(summarize('chat:env-context', {
      applied: true, bytes: 1234, toolNames: ['bash', 'edit', 'glob'],
    }), 'applied · 1234b · 3 tools');
    eq(summarize('chat:env-context', {
      applied: true, bytes: 50, toolNames: ['bash'],
    }), 'applied · 50b · 1 tool');
  });

  ctx.test('summarize: env-context not-applied shows reason', async () => {
    const { summarize } = await load();
    contains(summarize('chat:env-context', { applied: false, reason: 'disabled' }), 'disabled');
    contains(summarize('chat:env-context', { applied: false, reason: 'resolver-threw', error: 'boom' }), 'boom');
  });
}

module.exports = { run };
