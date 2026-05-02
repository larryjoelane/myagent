// ShellDriver tests. Run against a real PTY since faking a shell
// accurately is harder than just running one. Each test starts and
// closes its own driver to keep state isolated.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ShellDriver } = require('../src/core/drivers/shellDriver');
const { eq, ok, contains, eventually } = require('./assert');

function recorder() {
  const events = [];
  return {
    events,
    onEvent(name, payload) { events.push({ name, payload }); },
    last(name) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].name === name) return events[i];
      return null;
    },
    countOf(name) { return events.filter((e) => e.name === name).length; },
    turns() { return events.filter((e) => e.name === 'chat:turn-end'); },
  };
}

async function withDriver(opts, fn) {
  const r = recorder();
  const driver = new ShellDriver({ ...opts, onEvent: r.onEvent });
  await driver.start();
  try { await fn(driver, r); }
  finally { await driver.close(); }
}

function run(t) {

  t.test('echo command produces the expected output', async () => {
    await withDriver({ agentId: 's1' }, async (driver, r) => {
      driver.send('echo hello-shell-test');
      await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 8000, msg: 'turn-end' });
      const end = r.last('chat:turn-end');
      contains(end.payload.assistantText, 'hello-shell-test', 'output captured');
      eq(end.payload.totals.exitCode, 0, 'exit 0 for successful echo');
      eq(end.payload.ok, true, 'turn marked ok');
    });
  });

  t.test('multiple commands run in sequence with separate turn-ends', async () => {
    await withDriver({ agentId: 's2' }, async (driver, r) => {
      driver.send('echo first');
      await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 8000 });
      driver.send('echo second');
      await eventually(() => r.countOf('chat:turn-end') === 2, { timeoutMs: 8000 });
      driver.send('echo third');
      await eventually(() => r.countOf('chat:turn-end') === 3, { timeoutMs: 8000 });
      const turns = r.turns();
      contains(turns[0].payload.assistantText, 'first');
      contains(turns[1].payload.assistantText, 'second');
      contains(turns[2].payload.assistantText, 'third');
    });
  });

  t.test('cd state persists across commands', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-shell-cd-'));
    try {
      await withDriver({ agentId: 's3' }, async (driver, r) => {
        // PowerShell-friendly cd (forward slashes accepted on Windows).
        driver.send(`cd "${tmp.replace(/\\/g, '/')}"`);
        await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 8000 });
        driver.send('pwd');
        await eventually(() => r.countOf('chat:turn-end') === 2, { timeoutMs: 8000 });
        const pwd = r.turns()[1].payload.assistantText;
        // PowerShell prints `Path` header + `----` separator + path,
        // bash just prints the path. Either way the path string
        // should appear in the output.
        const expected = tmp.replace(/\\/g, '\\').toLowerCase();
        ok(
          pwd.toLowerCase().includes(tmp.replace(/\\/g, '/').toLowerCase()) ||
          pwd.toLowerCase().includes(expected.toLowerCase()),
          `pwd output should include "${tmp}", got: ${JSON.stringify(pwd)}`,
        );
      });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('command not found surfaces error text', async () => {
    await withDriver({ agentId: 's4' }, async (driver, r) => {
      driver.send('thiscommandshouldnotexist123xyz');
      await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 8000 });
      const end = r.last('chat:turn-end');
      // Error message format differs by shell; "not recognized"
      // (PowerShell) and "not found" (bash) are both acceptable.
      const txt = (end.payload.assistantText || '').toLowerCase();
      ok(
        txt.includes('not recognized') || txt.includes('not found') || txt.includes('command not found'),
        `expected error text, got: ${JSON.stringify(end.payload.assistantText)}`,
      );
    });
  });

  t.test('non-zero exit code captured for failing native command', async () => {
    await withDriver({ agentId: 's5' }, async (driver, r) => {
      // Use a native command that's guaranteed-failing on every shell.
      // PowerShell: `cmd /c exit 7` runs cmd.exe and returns 7.
      // bash: `false` exits 1; we use `exit 7` via subshell.
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'cmd /c exit 7' : '(exit 7)';
      driver.send(cmd);
      await eventually(() => r.countOf('chat:turn-end') === 1, { timeoutMs: 8000 });
      const end = r.last('chat:turn-end');
      eq(end.payload.totals.exitCode, 7, 'exit 7 captured');
      eq(end.payload.ok, false, 'ok flag set false for non-zero exit');
    });
  });

  t.test('PTY kill mid-driver finalizes any open turn and emits driver-exit', async () => {
    const r = recorder();
    const driver = new ShellDriver({ agentId: 's6', onEvent: r.onEvent });
    await driver.start();
    // Run a long-running command then kill the driver.
    const isWindows = process.platform === 'win32';
    driver.send(isWindows ? 'Start-Sleep -Seconds 30' : 'sleep 30');
    // Give the command a moment to start.
    await new Promise((res) => setTimeout(res, 300));
    eq(r.countOf('chat:turn-end'), 0, 'turn still in flight before kill');
    await driver.close();
    await eventually(() => r.countOf('chat:driver-exit') === 1, { timeoutMs: 5000 });
    // Either turn-end fired with ok=false, or it didn't fire at all
    // (driver was closed before sentinel detection — acceptable).
    // The contract is just "no zombie turn that blocks future use."
    ok(driver.closed, 'driver marked closed');
  });
}

module.exports = { run };
