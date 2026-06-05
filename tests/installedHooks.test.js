// Project-invariant tests for the hooks ACTUALLY INSTALLED in this repo
// (.myagent/hooks/*), loaded through the real production path.
//
// Why this file is separate from hooks.test.js: that file tests the loader
// and dispatcher *logic* with synthetic fixtures, and should stay decoupled
// from whatever happens to be on disk. This file tests a different thing —
// that the shipped hooks are wired for the phases they claim. It exists
// because a regression slipped past the synthetic tests once: the preTool
// INFRASTRUCTURE was correct and green, but the installed no-secrets hook
// still exported a bare function (preLlm-only), so a `write_file` of a
// secret was never gated and the file landed on disk. A synthetic test can
// never catch that; only loading the real file can.
//
// These drive discovery via createHookProvider against the repo root — the
// exact wiring electron/main.js uses (buildOpenAICompatibleWorker) — so the
// path under test is the same one a real worker takes.

const path = require('path');
const fs = require('fs');

const { createHookProvider } = require('../src/core/hooks');
const { runPreLlmHooks, runPreToolHooks } = require('../src/core/hookRunner');
const { eq, ok, contains } = require('./assert');

// Repo root = two levels up from this file (tests/ -> repo). Resolved from
// __dirname, not cwd, so the test is location-independent.
const REPO_ROOT = path.resolve(__dirname, '..');
const NO_SECRETS_DIR = path.join(REPO_ROOT, '.myagent', 'hooks', 'no-secrets');

// A representative AWS access key id: AKIA + 16 [A-Z0-9]. The same shape the
// user reported sailing through to disk. Fake, but matches the pattern.
const FAKE_AWS_KEY = 'AKIAFAKE1234TEST5678';

function loadRepoHooks() {
  // userHome pinned to a dir with no .claude/hooks so the global root
  // contributes nothing — we want ONLY this repo's project-local hooks.
  const emptyHome = path.join(REPO_ROOT, 'tests'); // has no .claude/hooks
  const provider = createHookProvider({ userHome: emptyHome, warn: () => {} });
  return provider(REPO_ROOT);
}

function run(ctx) {
  ctx.test('the no-secrets hook directory exists in the repo', () => {
    ok(fs.existsSync(path.join(NO_SECRETS_DIR, 'hook.js')),
      `expected an installed hook at ${NO_SECRETS_DIR}/hook.js`);
  });

  ctx.test('installed no-secrets hook loads with BOTH preLlm and preTool phases', () => {
    const hooks = loadRepoHooks();
    const guard = hooks.find((h) => h.name === 'no-secrets');
    ok(guard, 'no-secrets hook was discovered by the production provider');
    // This is the assertion that would have failed before the fix: a bare
    // function loads as preLlm-only, leaving preTool null and tool writes
    // ungated. If this fails, the on-disk hook regressed to a single
    // function — re-add the preTool phase (see docs/adding-a-hook.md).
    eq(typeof guard.preLlm, 'function', 'no-secrets must define a preLlm phase');
    eq(typeof guard.preTool, 'function',
      'no-secrets must define a preTool phase — without it, tool writes are NOT gated');
  });

  ctx.test('installed hook preTool BLOCKS a write_file carrying a secret (before disk)', async () => {
    const hooks = loadRepoHooks();
    const decision = await runPreToolHooks(hooks, {
      tool: 'write_file',
      args: { content: `${FAKE_AWS_KEY}\n` },
    });
    eq(decision.allow, false, 'a secret-bearing write must be blocked');
    eq(decision.blockedBy, 'no-secrets');
    contains(decision.reason, 'write_file');
  });

  ctx.test('installed hook preTool catches a secret regardless of arg key (edit/append/etc.)', async () => {
    const hooks = loadRepoHooks();
    // The hook serializes the whole args object, so the key name doesn't
    // matter — guards against a tool that names its payload something else.
    const decision = await runPreToolHooks(hooks, {
      tool: 'edit',
      args: { new_string: `key = "${FAKE_AWS_KEY}"` },
    });
    eq(decision.allow, false, 'secret in any arg field must be blocked');
  });

  ctx.test('installed hook preTool ALLOWS a benign write (no false-positive wedge)', async () => {
    const hooks = loadRepoHooks();
    const decision = await runPreToolHooks(hooks, {
      tool: 'write_file',
      args: { content: 'just some ordinary notes, nothing secret here' },
    });
    eq(decision.allow, true, 'a clean write must pass — a guardrail that blocks everything is broken');
  });

  ctx.test('installed hook preLlm still BLOCKS a secret in an outbound message (no regression)', async () => {
    const hooks = loadRepoHooks();
    const decision = await runPreLlmHooks(hooks, {
      messages: [{ role: 'user', content: `my key is ${FAKE_AWS_KEY}` }],
    });
    eq(decision.allow, false, 'a secret in a user message must still block the send');
    eq(decision.blockedBy, 'no-secrets');
  });

  ctx.test('installed hook preLlm ALLOWS a clean message', async () => {
    const hooks = loadRepoHooks();
    const decision = await runPreLlmHooks(hooks, {
      messages: [{ role: 'user', content: 'hello, can you help me refactor this function?' }],
    });
    eq(decision.allow, true);
  });
}

module.exports = { run };
