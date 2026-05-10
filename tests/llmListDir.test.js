// Tests for the list_dir tool. Real fs against a temp dir; scope is
// the actual Scope class.

const fs = require('fs');
const path = require('path');
const os = require('os');

const listDir = require('../src/core/llm/tools/listDir');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lsdir-')); }

function run(ctx) {
  ctx.test('list_dir: refuses without a scope', async () => {
    const dir = tmpdir();
    const result = await listDir.run({ path: dir }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('list_dir: refuses outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    const scope = new Scope([inside]);
    const result = await listDir.run({ path: outside }, { cwd: inside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });

  ctx.test('list_dir: lists files and dirs sorted dirs-first', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bb');
    fs.mkdirSync(path.join(dir, 'sub'));
    const scope = new Scope([dir]);
    const result = await listDir.run({ path: '.' }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, '[dir] sub');
    contains(result.content, '[file] a.txt');
    contains(result.content, '[file] b.txt');
    // dir comes before file in output
    const idxDir = result.content.indexOf('sub');
    const idxFile = result.content.indexOf('a.txt');
    ok(idxDir < idxFile, 'dirs should sort before files');
  });

  ctx.test('list_dir: hides node_modules / dotfiles by default', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    fs.writeFileSync(path.join(dir, 'visible.txt'), 'y');
    const scope = new Scope([dir]);
    const result = await listDir.run({ path: '.' }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'visible.txt');
    ok(!result.content.includes('node_modules'));
    ok(!result.content.includes('.hidden'));
  });

  ctx.test('list_dir: show_hidden=true reveals everything', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    const scope = new Scope([dir]);
    const result = await listDir.run({ path: '.', show_hidden: true }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'node_modules');
    contains(result.content, '.hidden');
  });

  ctx.test('list_dir: caps at max_entries and notes truncation', async () => {
    const dir = tmpdir();
    for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    const scope = new Scope([dir]);
    const result = await listDir.run({ path: '.', max_entries: 3 }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.content, 'showing first 3');
    eq(result.data.truncated, true);
  });

  ctx.test('list_dir: file path rejected as not-a-directory', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const scope = new Scope([dir]);
    const result = await listDir.run({ path: 'a.txt' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'not a directory');
  });
}

module.exports = { run };
