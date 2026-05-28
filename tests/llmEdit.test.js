// Tests for the `edit` tool. Real fs against a temp dir; scope
// enforcement uses the actual Scope class.

const fs = require('fs');
const path = require('path');
const os = require('os');

const edit = require('../src/core/llm/tools/edit');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmedit-'));
}

function run(ctx) {
  ctx.test('edit: refuses without a scope', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello');
    const result = await edit.run({ file_path: file, old_string: 'hello', new_string: 'hi' }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('edit: refuses paths outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    const target = path.join(outside, 'a.txt');
    fs.writeFileSync(target, 'hi');
    const scope = new Scope([inside]);
    const result = await edit.run({ file_path: target, old_string: 'hi', new_string: 'bye' }, { cwd: inside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
    eq(fs.readFileSync(target, 'utf8'), 'hi');
  });

  ctx.test('edit: unique match replaces and writes', async () => {
    const dir = tmpdir();
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'foo bar baz\n');
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'a.txt', old_string: 'bar', new_string: 'BAR' }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.replacements, 1);
    eq(fs.readFileSync(target, 'utf8'), 'foo BAR baz\n');
  });

  ctx.test('edit: refuses non-unique match without replace_all', async () => {
    const dir = tmpdir();
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'foo foo foo');
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'a.txt', old_string: 'foo', new_string: 'bar' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'matches 3 locations');
    eq(fs.readFileSync(target, 'utf8'), 'foo foo foo');
  });

  ctx.test('edit: replace_all replaces every occurrence', async () => {
    const dir = tmpdir();
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'foo foo foo');
    const scope = new Scope([dir]);
    const result = await edit.run(
      { file_path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      { cwd: dir, scope }
    );
    eq(result.ok, true);
    eq(result.data.replacements, 3);
    eq(fs.readFileSync(target, 'utf8'), 'bar bar bar');
  });

  ctx.test('edit: missing old_string is an error', async () => {
    const dir = tmpdir();
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'hello world');
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'a.txt', old_string: 'nope', new_string: 'x' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'not found');
    eq(fs.readFileSync(target, 'utf8'), 'hello world');
  });

  ctx.test('edit: empty old_string refused', async () => {
    const dir = tmpdir();
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'x');
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'a.txt', old_string: '', new_string: 'y' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'must not be empty');
  });

  ctx.test('edit: identical strings refused', async () => {
    const dir = tmpdir();
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'foo');
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'a.txt', old_string: 'foo', new_string: 'foo' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'identical');
  });

  ctx.test('edit: directory target rejected', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'sub'));
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'sub', old_string: 'x', new_string: 'y' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'is a directory');
  });

  ctx.test('edit: nonexistent file rejected', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await edit.run({ file_path: 'ghost.txt', old_string: 'x', new_string: 'y' }, { cwd: dir, scope });
    eq(result.ok, false);
    ok(/cannot stat|ENOENT/i.test(result.content), `expected stat error, got: ${result.content}`);
  });
}

module.exports = { run };
