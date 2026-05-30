// Tests for envContext resolution + the default builder.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildDefaultEnvContext, resolveEnvContext } = require('../src/core/envContext');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains, notContains, deepEq } = require('./assert');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envctx-'));
}

function run(ctx) {
  ctx.test('buildDefaultEnvContext: includes date, platform, cwd, scope', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const out = await buildDefaultEnvContext({ cwd: dir, scope, date: '2026-05-28', skipGit: true });
    contains(out, '# Environment');
    contains(out, '- date: 2026-05-28');
    contains(out, '- platform: ');
    contains(out, `- cwd: ${dir}`);
    contains(out, '- scope:');
    contains(out, dir);
  });

  ctx.test('buildDefaultEnvContext: omits git block when skipGit=true', async () => {
    const dir = tmpdir();
    const out = await buildDefaultEnvContext({ cwd: dir, skipGit: true });
    notContains(out, '- git:');
  });

  ctx.test('buildDefaultEnvContext: extraLines are appended verbatim', async () => {
    const out = await buildDefaultEnvContext({
      cwd: tmpdir(),
      skipGit: true,
      extraLines: ['- custom: value-here'],
    });
    contains(out, '- custom: value-here');
  });

  ctx.test('resolveEnvContext: null/false disable', async () => {
    eq(await resolveEnvContext(null), null);
    eq(await resolveEnvContext(false), null);
  });

  ctx.test('resolveEnvContext: string is used verbatim', async () => {
    eq(await resolveEnvContext('hello env'), 'hello env');
  });

  ctx.test('resolveEnvContext: function gets opts and is awaited', async () => {
    const out = await resolveEnvContext(
      async ({ cwd }) => `here: ${cwd}`,
      { cwd: '/tmp/x' }
    );
    eq(out, 'here: /tmp/x');
  });

  ctx.test('resolveEnvContext: function returning empty becomes null', async () => {
    eq(await resolveEnvContext(() => ''), null);
    eq(await resolveEnvContext(() => null), null);
  });

  ctx.test('resolveEnvContext: true builds default', async () => {
    const out = await resolveEnvContext(true, { cwd: tmpdir(), skipGit: true });
    contains(out, '# Environment');
  });

  ctx.test('resolveEnvContext: object merges onto defaults', async () => {
    const out = await resolveEnvContext({ header: '# Custom', skipGit: true }, { cwd: tmpdir() });
    contains(out, '# Custom');
    ok(!out.includes('# Environment'));
  });

  ctx.test('toolHints: appended when toolNames provided', async () => {
    const out = await buildDefaultEnvContext({
      cwd: tmpdir(), skipGit: true,
      toolNames: ['bash', 'read_file', 'edit'],
    });
    contains(out, '# Tool use');
    contains(out, 'STRUCTURED tool_call');
    contains(out, 'bash, read_file, edit');
  });

  ctx.test('toolHints: omitted when toolNames is empty/missing', async () => {
    const a = await buildDefaultEnvContext({ cwd: tmpdir(), skipGit: true });
    const b = await buildDefaultEnvContext({ cwd: tmpdir(), skipGit: true, toolNames: [] });
    ok(!a.includes('# Tool use'), `expected no tool block, got: ${a}`);
    ok(!b.includes('# Tool use'), `expected no tool block, got: ${b}`);
  });

  ctx.test('toolHints: explicit false suppresses even with toolNames', async () => {
    const out = await buildDefaultEnvContext({
      cwd: tmpdir(), skipGit: true,
      toolNames: ['bash'],
      toolHints: false,
    });
    ok(!out.includes('# Tool use'));
  });

  ctx.test('toolHints: shell hint included on win32 when bash tool present', async () => {
    const out = await buildDefaultEnvContext({
      cwd: tmpdir(), skipGit: true,
      toolNames: ['bash', 'read_file'],
    });
    if (process.platform === 'win32') {
      contains(out, 'PowerShell');
      contains(out, "'&&'");
      contains(out, 'if ($?)');
    } else {
      ok(!out.includes('PowerShell'), `non-win32 should not get the PowerShell hint; got: ${out}`);
    }
  });

  ctx.test('toolHints: no shell hint when bash tool absent', async () => {
    const out = await buildDefaultEnvContext({
      cwd: tmpdir(), skipGit: true,
      toolNames: ['read_file', 'edit'],
    });
    ok(!out.includes('PowerShell'), 'shell hint should be gated on bash being available');
  });

  ctx.test('resolveEnvContext: toolNames flows through opts to function spec', async () => {
    let received = null;
    await resolveEnvContext((opts) => { received = opts; return 'x'; },
      { cwd: '/x', toolNames: ['bash', 'edit'] });
    deepEq(received.toolNames, ['bash', 'edit']);
  });
}

module.exports = { run };
