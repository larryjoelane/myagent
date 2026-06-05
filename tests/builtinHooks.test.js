// Tests for the built-in no-secrets guardrail (src/core/builtinHooks/).
//
// The built-in is what makes the guardrail ALWAYS-ON: it ships with the app
// and is merged into every worker's hook set by createHookProvider,
// independent of cwd or any installed hook file. The reported bug was a
// worker opened in a directory with no hook folder — discovery found
// nothing, so a secret write was never gated. This file pins the built-in's
// own behavior; hooks.test.js covers that the provider always includes it.

const { noSecretsHook, detectSecret, SECRET_PATTERNS } = require('../src/core/builtinHooks/noSecrets');
const { BUILTIN_HOOKS } = require('../src/core/builtinHooks');
const { eq, ok, contains } = require('./assert');

const FAKE_AWS_KEY = 'AKIAFAKE1234TEST5678';

function run(ctx) {
  ctx.test('BUILTIN_HOOKS includes no-secrets with both phases', () => {
    const guard = BUILTIN_HOOKS.find((h) => h.name === 'no-secrets');
    ok(guard, 'no-secrets is a built-in');
    eq(typeof guard.preLlm, 'function');
    eq(typeof guard.preTool, 'function');
    // It is NOT a discovered hook, so it has no real dir.
    eq(guard.dir, null);
  });

  ctx.test('detectSecret matches the documented credential shapes', () => {
    ok(detectSecret(FAKE_AWS_KEY), 'AWS access key id');
    ok(detectSecret('sk-' + 'a'.repeat(24)), 'OpenAI-style key');
    ok(detectSecret('-----BEGIN RSA PRIVATE KEY-----'), 'private key block');
    ok(detectSecret('password = hunter2'), 'inline password');
    eq(detectSecret('just an ordinary sentence'), null, 'clean text is not a secret');
    eq(detectSecret(undefined), null, 'non-string is safe');
  });

  ctx.test('SECRET_PATTERNS each carry a label (used in block reasons)', () => {
    for (const p of SECRET_PATTERNS) {
      ok(p.label && typeof p.label === 'string', 'pattern has a label');
      ok(p.re instanceof RegExp, 'pattern has a regex');
    }
  });

  ctx.test('preTool blocks a secret-bearing write and names the tool', () => {
    const d = noSecretsHook.preTool({ tool: 'write_file', args: { content: `${FAKE_AWS_KEY}\n` } });
    eq(d.allow, false);
    contains(d.reason, 'write_file');
    contains(d.reason, 'AWS access key');
  });

  ctx.test('preTool serializes args so any field is checked (string args too)', () => {
    // Object arg in an unusual field:
    eq(noSecretsHook.preTool({ tool: 'edit', args: { whatever: FAKE_AWS_KEY } }).allow, false);
    // Pre-stringified args (some callers pass the raw JSON string):
    eq(noSecretsHook.preTool({ tool: 'bash', args: JSON.stringify({ cmd: `echo ${FAKE_AWS_KEY}` }) }).allow, false);
    // Clean write passes.
    eq(noSecretsHook.preTool({ tool: 'write_file', args: { content: 'hello world' } }).allow, true);
  });

  ctx.test('preLlm blocks a secret in a message and allows a clean one', () => {
    eq(noSecretsHook.preLlm({ messages: [{ role: 'user', content: `key ${FAKE_AWS_KEY}` }] }).allow, false);
    eq(noSecretsHook.preLlm({ messages: [{ role: 'user', content: 'hi there' }] }).allow, true);
    // Defensive: non-array messages must not throw.
    eq(noSecretsHook.preLlm({ messages: undefined }).allow, true);
  });
}

module.exports = { run };
