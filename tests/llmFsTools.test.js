// Tests for the read_file and write_file tool modules. Real fs against
// a temp dir; scope enforcement uses the actual Scope class.

const fs = require('fs');
const path = require('path');
const os = require('os');

const readFile = require('../src/core/llm/tools/readFile');
const writeFile = require('../src/core/llm/tools/writeFile');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmtools-'));
  return dir;
}

function run(ctx) {
  ctx.test('read_file: refuses without a scope', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hi');
    const result = await readFile.run({ path: file }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('read_file: refuses paths outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, 'leak.txt'), 'secret');
    const scope = new Scope([inside]);
    const result = await readFile.run({ path: path.join(outside, 'leak.txt') }, { cwd: inside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });

  ctx.test('read_file: reads a file inside scope with line numbers', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const scope = new Scope([dir]);
    const result = await readFile.run({ path: 'a.txt' }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'a.txt (lines 1-4');
    contains(result.content, '    1  one');
    contains(result.content, '    3  three');
    eq(result.data.totalLines, 4);
  });

  ctx.test('read_file: line range honored', async () => {
    const dir = tmpdir();
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), lines);
    const scope = new Scope([dir]);
    const result = await readFile.run({ path: 'b.txt', start_line: 10, end_line: 12 }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'line10');
    contains(result.content, 'line12');
    ok(!result.content.includes('line9'));
    ok(!result.content.includes('line13'));
    eq(result.data.start, 10);
    eq(result.data.end, 12);
  });

  ctx.test('read_file: refuses oversized files', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(2000));
    const scope = new Scope([dir]);
    const result = await readFile.run({ path: 'big.txt', max_bytes: 100 }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'limit 100');
  });

  ctx.test('read_file: directory target rejected', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'sub'));
    const scope = new Scope([dir]);
    const result = await readFile.run({ path: 'sub' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'is a directory');
  });

  ctx.test('write_file: refuses without a scope', async () => {
    const dir = tmpdir();
    const result = await writeFile.run({ path: path.join(dir, 'x.txt'), content: 'hi' }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('write_file: refuses outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    const scope = new Scope([inside]);
    const result = await writeFile.run({ path: path.join(outside, 'leak.txt'), content: 'x' }, { cwd: inside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });

  ctx.test('write_file: creates a new file inside scope', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const target = path.join(dir, 'new.txt');
    const result = await writeFile.run({ path: 'new.txt', content: 'fresh' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.created, true);
    eq(fs.readFileSync(target, 'utf8'), 'fresh');
  });

  ctx.test('write_file: overwrites by default', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const target = path.join(dir, 'over.txt');
    fs.writeFileSync(target, 'old');
    const result = await writeFile.run({ path: 'over.txt', content: 'new' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.created, false);
    eq(fs.readFileSync(target, 'utf8'), 'new');
  });

  ctx.test('write_file: mode=create refuses to overwrite', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const target = path.join(dir, 'exists.txt');
    fs.writeFileSync(target, 'old');
    const result = await writeFile.run({ path: 'exists.txt', content: 'new', mode: 'create' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'already exists');
    eq(fs.readFileSync(target, 'utf8'), 'old');
  });

  ctx.test('write_file: creates parent directories', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await writeFile.run({ path: 'a/b/c/deep.txt', content: 'd' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.parentCreated, true);
    eq(fs.readFileSync(path.join(dir, 'a/b/c/deep.txt'), 'utf8'), 'd');
  });

  ctx.test('write_file: refuses oversized payloads', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await writeFile.run({ path: 'big.txt', content: 'x'.repeat(200), max_bytes: 50 }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'limit 50');
  });

  ctx.test('write_file: directory target rejected', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'realdir'));
    const scope = new Scope([dir]);
    const result = await writeFile.run({ path: 'realdir', content: 'x' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'is a directory');
  });
}

module.exports = { run };
