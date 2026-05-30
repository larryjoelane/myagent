// Tests for the glob tool. Real fs against a temp tree; the matcher
// is exercised on a small but realistic directory structure.

const fs = require('fs');
const path = require('path');
const os = require('os');

const glob = require('../src/core/llm/tools/glob');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmglob-'));
}

function seed(dir, layout) {
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

function run(ctx) {
  ctx.test('glob: refuses without scope', async () => {
    const dir = tmpdir();
    const result = await glob.run({ pattern: '*.js' }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('glob: refuses cwd outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    const scope = new Scope([inside]);
    const result = await glob.run({ pattern: '*.js', cwd: outside }, { cwd: inside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });

  ctx.test('glob: simple star matches files in cwd', async () => {
    const dir = tmpdir();
    seed(dir, { 'a.js': '', 'b.js': '', 'c.txt': '' });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '*.js' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 2);
    ok(result.data.matches.includes('a.js'));
    ok(result.data.matches.includes('b.js'));
  });

  ctx.test('glob: ** matches across directories', async () => {
    const dir = tmpdir();
    seed(dir, {
      'src/a.ts': '',
      'src/sub/b.ts': '',
      'src/sub/deep/c.ts': '',
      'src/sub/deep/d.txt': '',
    });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: 'src/**/*.ts' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 3);
    ok(result.data.matches.includes('src/a.ts'));
    ok(result.data.matches.includes('src/sub/b.ts'));
    ok(result.data.matches.includes('src/sub/deep/c.ts'));
  });

  ctx.test('glob: alternation {a,b}', async () => {
    const dir = tmpdir();
    seed(dir, { 'x.ts': '', 'x.tsx': '', 'x.js': '' });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '*.{ts,tsx}' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 2);
    ok(result.data.matches.includes('x.ts'));
    ok(result.data.matches.includes('x.tsx'));
  });

  ctx.test('glob: ? matches single char', async () => {
    const dir = tmpdir();
    seed(dir, { 'a.js': '', 'ab.js': '', 'abc.js': '' });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '?.js' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 1);
    eq(result.data.matches[0], 'a.js');
  });

  ctx.test('glob: prunes node_modules by default', async () => {
    const dir = tmpdir();
    seed(dir, {
      'src/a.js': '',
      'node_modules/foo/index.js': '',
      'node_modules/bar/index.js': '',
    });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '**/*.js' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 1);
    eq(result.data.matches[0], 'src/a.js');
  });

  ctx.test('glob: literal node_modules in pattern re-enables that walk', async () => {
    const dir = tmpdir();
    seed(dir, {
      'src/a.js': '',
      'node_modules/foo/index.js': '',
    });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: 'node_modules/**/*.js' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 1);
    eq(result.data.matches[0], 'node_modules/foo/index.js');
  });

  ctx.test('glob: max_results caps and reports truncation', async () => {
    const dir = tmpdir();
    const layout = {};
    for (let i = 0; i < 50; i++) layout[`f${i}.js`] = '';
    seed(dir, layout);
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '*.js', max_results: 10 }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 10);
    eq(result.data.truncated, true);
    contains(result.content, 'capped at 10');
  });

  ctx.test('glob: include_dirs=true matches directories too', async () => {
    const dir = tmpdir();
    seed(dir, { 'foo/.keep': '', 'bar/.keep': '' });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '*', include_dirs: true }, { cwd: dir, scope });
    eq(result.ok, true);
    ok(result.data.matches.includes('foo'));
    ok(result.data.matches.includes('bar'));
  });

  ctx.test('glob: missing pattern is an error', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await glob.run({}, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'pattern');
  });

  ctx.test('glob: zero matches returns ok=true with (none)', async () => {
    const dir = tmpdir();
    seed(dir, { 'a.txt': '' });
    const scope = new Scope([dir]);
    const result = await glob.run({ pattern: '*.js' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.matches.length, 0);
    contains(result.content, '(none)');
  });
}

module.exports = { run };
