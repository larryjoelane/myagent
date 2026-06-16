// Locks the security boundary of the `bash` tool. The tool spawns an arbitrary
// shell command by design (CodeQL js/command-line-injection #14/#15), so the
// protection is the gate, not the spawn: it must REFUSE before spawning when
//   (a) no scope is present on the context, or
//   (b) the requested cwd is outside the allowed scopes.
// These tests assert the refusal happens (no child process is ever created).

const bash = require('../src/core/llm/tools/bash');
const { ok, contains, eq } = require('./assert');

// A scope stub whose containsSync we fully control.
function scopeAllowing(predicate) {
  return { containsSync: (p) => predicate(p) };
}

function run(ctx) {
  ctx.test('bash refuses when no scope is on the context', async () => {
    const res = await bash.run({ command: 'echo hi' }, { cwd: process.cwd() });
    eq(res.ok, false, 'must refuse');
    contains(res.content, 'no scope', 'explains the refusal');
  });

  ctx.test('bash refuses when scope.containsSync is not a function', async () => {
    const res = await bash.run({ command: 'echo hi' }, { cwd: process.cwd(), scope: {} });
    eq(res.ok, false, 'must refuse a malformed scope');
    contains(res.content, 'no scope', 'explains the refusal');
  });

  ctx.test('bash refuses a cwd outside the allowed scopes', async () => {
    const scope = scopeAllowing(() => false); // nothing is in scope
    const res = await bash.run(
      { command: 'echo hi', cwd: process.cwd() },
      { cwd: process.cwd(), scope },
    );
    eq(res.ok, false, 'must refuse out-of-scope cwd');
    contains(res.content, 'outside allowed scopes', 'explains the refusal');
  });

  ctx.test('bash runs a harmless command when cwd is in scope', async () => {
    const scope = scopeAllowing(() => true); // everything in scope
    const res = await bash.run(
      { command: 'echo myagent-gate-ok' },
      { cwd: process.cwd(), scope },
    );
    eq(res.ok, true, 'should run when gated cwd is allowed');
    contains(res.content, 'myagent-gate-ok', 'command output flows back');
  });
}

module.exports = { run };
