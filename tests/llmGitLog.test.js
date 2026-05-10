// Tests for the git_log tool. Builds a real git repo in a temp dir
// so we exercise actual `git log` parsing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const gitLog = require('../src/core/llm/tools/gitLog');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gitlog-')); }

function makeRepo(dir, commits = 3) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  for (let i = 1; i <= commits; i += 1) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', `commit ${i}`], { cwd: dir });
  }
}

function run(ctx) {
  ctx.test('git_log: refuses without a scope', async () => {
    const dir = tmpdir();
    const result = await gitLog.run({}, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('git_log: refuses when cwd not a git repo', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await gitLog.run({}, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'not a git repo');
  });

  ctx.test('git_log: returns recent commits', async () => {
    const dir = tmpdir();
    makeRepo(dir, 3);
    const scope = new Scope([dir]);
    const result = await gitLog.run({}, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.commits.length, 3);
    contains(result.content, 'commit 3');
    contains(result.content, 'commit 2');
    contains(result.content, 'commit 1');
  });

  ctx.test('git_log: limit caps results', async () => {
    const dir = tmpdir();
    makeRepo(dir, 5);
    const scope = new Scope([dir]);
    const result = await gitLog.run({ limit: 2 }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.commits.length, 2);
  });

  ctx.test('git_log: refuses path filter outside scope', async () => {
    const dir = tmpdir();
    makeRepo(dir, 1);
    const outside = tmpdir();
    const scope = new Scope([dir]);
    const result = await gitLog.run({ path: outside }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });
}

module.exports = { run };
