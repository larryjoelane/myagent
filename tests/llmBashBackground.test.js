// Tests for bash run_in_background + bash_output, bash_kill, bash_list,
// and the processes registry's ring buffer / cursor semantics.

const fs = require('fs');
const path = require('path');
const os = require('os');

const bash = require('../src/core/llm/tools/bash');
const bashOutput = require('../src/core/llm/tools/bashOutput');
const bashKill = require('../src/core/llm/tools/bashKill');
const bashList = require('../src/core/llm/tools/bashList');
const processes = require('../src/core/llm/tools/bash/processes');
const { Registry, RingBuffer } = processes;
const { Scope } = require('../src/core/scope');
const { eq, ok, contains } = require('./assert');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmbg-'));
}

function backgroundCmd() {
  // A command that prints a marker, sleeps, then prints another marker
  // and exits. Lets us prove streaming + final state both work.
  if (process.platform === 'win32') {
    return `Write-Output 'START'; Start-Sleep -Milliseconds 200; Write-Output 'END'`;
  }
  return `echo START; sleep 0.2; echo END`;
}

function loopForeverCmd() {
  if (process.platform === 'win32') {
    return `while ($true) { Write-Output 'tick'; Start-Sleep -Milliseconds 100 }`;
  }
  return `while true; do echo tick; sleep 0.1; done`;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function run(ctx) {
  // ---- RingBuffer unit tests ----------------------------------------------

  ctx.test('RingBuffer: small writes are fully retained', () => {
    const rb = new RingBuffer(1000);
    rb.append(Buffer.from('hello '));
    rb.append(Buffer.from('world'));
    const r = rb.readSince(0);
    eq(r.text, 'hello world');
    eq(r.nextCursor, 11);
    eq(r.truncated, false);
  });

  ctx.test('RingBuffer: cursor returns only new bytes', () => {
    const rb = new RingBuffer(1000);
    rb.append(Buffer.from('first '));
    const a = rb.readSince(0);
    rb.append(Buffer.from('second'));
    const b = rb.readSince(a.nextCursor);
    eq(b.text, 'second');
    eq(b.nextCursor, 12);
    eq(b.truncated, false);
  });

  ctx.test('RingBuffer: overflow drops earliest bytes and flags truncation', () => {
    const rb = new RingBuffer(10);
    rb.append(Buffer.from('0123456789'));      // exactly full
    rb.append(Buffer.from('ABCDE'));           // overflow 5 bytes
    const r = rb.readSince(0);
    // earliest available is offset 5
    eq(r.text, '56789ABCDE');
    eq(r.truncated, true);
    eq(r.nextCursor, 15);
  });

  // ---- run_in_background end-to-end --------------------------------------

  ctx.test('bash run_in_background: returns pid immediately and survives the call', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const result = await bash.run(
      { command: backgroundCmd(), run_in_background: true },
      { cwd: dir, scope }
    );
    eq(result.ok, true);
    ok(typeof result.data.pid === 'number', 'pid should be a number');
    eq(result.data.background, true);
    contains(result.content, `pid=${result.data.pid}`);
    // Cleanup
    processes.remove(result.data.pid);
  });

  ctx.test('bash_output: incremental cursor returns only new bytes', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const spawn = await bash.run(
      { command: backgroundCmd(), run_in_background: true },
      { cwd: dir, scope }
    );
    const pid = spawn.data.pid;

    // Wait for START to appear.
    let first;
    for (let i = 0; i < 50; i++) {
      first = await bashOutput.run({ pid });
      if (first.data.stdout.includes('START')) break;
      await wait(50);
    }
    ok(first.data.stdout.includes('START'), `expected START in stdout, got: ${first.data.stdout}`);

    // Second read with the cursor should NOT re-deliver START.
    const cursor1 = first.data.next_cursor;
    // Wait until either END appears OR the process exits.
    let second;
    for (let i = 0; i < 50; i++) {
      second = await bashOutput.run({ pid, cursor: cursor1 });
      if (second.data.stdout.includes('END') || second.data.status === 'exited') break;
      await wait(50);
    }
    ok(!second.data.stdout.includes('START'), 'incremental read must not re-include START');
    ok(second.data.stdout.includes('END') || second.data.status === 'exited',
       `expected END or exit, got status=${second.data.status} stdout=${second.data.stdout}`);

    processes.remove(pid);
  });

  ctx.test('bash_output: status flips to exited with exit_code', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const spawn = await bash.run(
      { command: backgroundCmd(), run_in_background: true },
      { cwd: dir, scope }
    );
    const pid = spawn.data.pid;
    // Wait up to 3s for exit.
    let r;
    for (let i = 0; i < 60; i++) {
      r = await bashOutput.run({ pid });
      if (r.data.status === 'exited') break;
      await wait(50);
    }
    eq(r.data.status, 'exited');
    eq(r.data.exit_code, 0);
    processes.remove(pid);
  });

  ctx.test('bash_kill: stops a running background process', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const spawn = await bash.run(
      { command: loopForeverCmd(), run_in_background: true },
      { cwd: dir, scope }
    );
    const pid = spawn.data.pid;
    // Confirm it's running.
    await wait(150);
    const before = await bashOutput.run({ pid });
    eq(before.data.status, 'running');

    const killResult = await bashKill.run({ pid, signal: 'SIGKILL', remove: false });
    eq(killResult.ok, true);
    // Wait for the exit to propagate.
    let after;
    for (let i = 0; i < 40; i++) {
      after = await bashOutput.run({ pid });
      if (after.data.status === 'exited') break;
      await wait(50);
    }
    eq(after.data.status, 'exited');
    processes.remove(pid);
  });

  ctx.test('bash_kill: unknown pid is a clean error', async () => {
    const result = await bashKill.run({ pid: 99999999 });
    eq(result.ok, false);
    contains(result.content, 'no process');
  });

  ctx.test('bash_list: includes a freshly-spawned background process', async () => {
    const dir = tmpdir();
    const scope = new Scope([dir]);
    const spawn = await bash.run(
      { command: loopForeverCmd(), run_in_background: true },
      { cwd: dir, scope }
    );
    const pid = spawn.data.pid;

    const list = await bashList.run({});
    eq(list.ok, true);
    const entry = list.data.entries.find((e) => e.pid === pid);
    ok(entry, `pid ${pid} should appear in bash_list`);
    eq(entry.status, 'running');

    await bashKill.run({ pid, signal: 'SIGKILL', remove: true });
  });

  ctx.test('bash_output: rejects unknown pid', async () => {
    const result = await bashOutput.run({ pid: 99999999 });
    eq(result.ok, false);
    contains(result.content, 'no process');
  });
}

module.exports = { run };
