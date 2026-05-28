// Tests for the `bash` tool. Real child_process; cross-platform by
// branching on the platform's shell.

const fs = require('fs');
const path = require('path');
const os = require('os');

const bash = require('../src/core/llm/tools/bash');
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmbash-'));
}

// Pick a command appropriate to the current shell that just prints "hi".
function echoCmd(text) {
  if (process.platform === 'win32') {
    return `Write-Output '${text}'`;
  }
  return `printf '%s' '${text}'`;
}

// A command that exits 1 with some stderr.
function failCmd() {
  if (process.platform === 'win32') {
    return `Write-Error 'boom'; exit 1`;
  }
  return `echo boom 1>&2; exit 1`;
}

// A long sleep — used for timeout testing.
function sleepCmd(seconds) {
  if (process.platform === 'win32') {
    return `Start-Sleep -Seconds ${seconds}`;
  }
  return `sleep ${seconds}`;
}

function run(ctx) {
  ctx.test('bash: refuses without a scope', async () => {
    const dir = tmpdir();
    const result = await bash.run({ command: echoCmd('hi') }, { cwd: dir });
    eq(result.ok, false);
    contains(result.content, 'no scope');
  });

  ctx.test('bash: refuses cwd outside scope', async () => {
    const inside = tmpdir();
    const outside = tmpdir();
    const scope = new Scope([inside]);
    const result = await bash.run({ command: echoCmd('hi'), cwd: outside }, { cwd: inside, scope });
    eq(result.ok, false);
    contains(result.content, 'outside allowed scopes');
  });

  ctx.test('bash: captures stdout and exit 0', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await bash.run({ command: echoCmd('hello-from-bash') }, { cwd: dir, scope });
    eq(result.ok, true);
    eq(result.data.exitCode, 0);
    contains(result.data.stdout, 'hello-from-bash');
    eq(result.data.timedOut, false);
  });

  ctx.test('bash: nonzero exit is ok=false with stderr captured', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await bash.run({ command: failCmd() }, { cwd: dir, scope });
    eq(result.ok, false);
    eq(result.data.exitCode, 1);
    contains(result.data.stderr, 'boom');
  });

  ctx.test('bash: cwd is honored', async () => {
    const dir = tmpdir();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'marker.txt'), 'x');
    const scope = new Scope([dir]);
    const cmd = process.platform === 'win32'
      ? 'Get-ChildItem -Name'
      : 'ls';
    const result = await bash.run({ command: cmd, cwd: sub }, { cwd: dir, scope });
    eq(result.ok, true);
    contains(result.data.stdout, 'marker.txt');
  });

  ctx.test('bash: timeout kills the process', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await bash.run(
      { command: sleepCmd(30), timeout_ms: 300 },
      { cwd: dir, scope }
    );
    eq(result.data.timedOut, true);
    eq(result.ok, false);
  });

  ctx.test('bash: stdout truncated past max_output_bytes', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const cmd = process.platform === 'win32'
      ? `1..1000 | ForEach-Object { Write-Output 'xxxxxxxxxx' }`
      : `for i in $(seq 1 1000); do echo xxxxxxxxxx; done`;
    const result = await bash.run(
      { command: cmd, max_output_bytes: 200 },
      { cwd: dir, scope }
    );
    eq(result.data.stdoutTruncated, true);
    ok(result.data.stdout.length <= 200, `stdout length ${result.data.stdout.length} should be <= 200`);
  });

  ctx.test('bash: missing command refused', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await bash.run({ command: '   ' }, { cwd: dir, scope });
    eq(result.ok, false);
    contains(result.content, 'missing required argument');
  });
}

module.exports = { run };
