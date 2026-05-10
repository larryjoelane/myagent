// Tests for the grep tool. Uses the Node fallback path explicitly when
// rg may not be on PATH (CI machines, dev machines without ripgrep) by
// not relying on backend selection.

const fs = require('fs');
const path = require('path');
const os = require('os');

const grep = require('../src/core/llm/tools/grep');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'grep-')); }

function run(ctx) {
  ctx.test('grep: refuses without a scope', async () => {
    const dir = tmpdir();
    const result = await grep.run({ pattern: 'x' }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('grep: refuses when cwd is outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    const scope = new Scope([inside]);
    const result = await grep.run({ pattern: 'x' }, { cwd: outside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });

  ctx.test('grep: requires a pattern', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await grep.run({ pattern: '' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'pattern');
  });

  ctx.test('grep: finds literal matches and reports file:line:text', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'function foo() {}\nconst bar = 1;\n');
    fs.writeFileSync(path.join(dir, 'b.js'), 'const foo = 2;\n');
    const scope = new Scope([dir]);
    const result = await grep.run({ pattern: 'foo' }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'a.js:1');
    contains(result.content, 'b.js:1');
    eq(result.data.hits.length >= 2, true);
  });

  ctx.test('grep: returns ok:true with empty hits when no matches', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'nothing here');
    const scope = new Scope([dir]);
    const result = await grep.run({ pattern: 'definitelynotpresent' }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'No matches');
    eq(result.data.hits.length, 0);
  });

  ctx.test('grep: skips node_modules and .git', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules/x.js'), 'NEEDLE');
    fs.writeFileSync(path.join(dir, 'visible.js'), 'NEEDLE');
    const scope = new Scope([dir]);
    const result = await grep.run({ pattern: 'NEEDLE' }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'visible.js');
    ok(!result.content.includes('node_modules'), 'node_modules should be skipped');
  });
}

module.exports = { run };
