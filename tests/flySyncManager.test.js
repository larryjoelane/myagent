// FlySyncManager tests. Stubs a flyClient.exec (FlySyncSession's only
// network-adjacent call) and uses real temp-dir filesystem so
// pushAll/watch work for real.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FlySyncManager } = require('../src/core/fly/flySyncManager');
const { eq, ok } = require('./assert');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flysyncmgr-'));
}

function fakeFlyClient() {
  const calls = [];
  return {
    calls,
    async exec(appName, machineId, command, opts) {
      calls.push({ appName, machineId, command, opts });
      return { exit_code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  };
}

exports.run = (t) => {
  t.test('push creates a session and pushes every file once', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    fs.writeFileSync(path.join(dir, 'b.js'), 'b');
    const mgr = new FlySyncManager();
    const flyClient = fakeFlyClient();
    const result = await mgr.push('w1', dir, { appName: 'app', machineId: 'm1', syncAgentAddr: 'app.fly.dev:39201' }, flyClient);

    eq(result.ok, true, 'success');
    eq(result.pushed, 2, 'pushed both files');
    eq(flyClient.calls.length, 2, 'two PUT calls');
    mgr.closeFor('w1');
  });

  t.test('push reuses the existing session for the same worker+root', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    const mgr = new FlySyncManager();
    const flyClient = fakeFlyClient();
    await mgr.push('w1', dir, { appName: 'app', machineId: 'm1', syncAgentAddr: 'app.fly.dev:39201' }, flyClient);
    const sessionAfterFirst = mgr.sessions.get('w1');
    await mgr.push('w1', dir, { appName: 'app', machineId: 'm1', syncAgentAddr: 'app.fly.dev:39201' }, flyClient);
    eq(mgr.sessions.get('w1'), sessionAfterFirst, 'same session instance reused');
    mgr.closeFor('w1');
  });

  t.test('push replaces the session when machineId changes (fresh deploy)', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    const mgr = new FlySyncManager();
    const flyClient = fakeFlyClient();
    await mgr.push('w1', dir, { appName: 'old-app', machineId: 'm1', syncAgentAddr: 'old-app.fly.dev:39201' }, flyClient);
    const oldSession = mgr.sessions.get('w1');
    await mgr.push('w1', dir, { appName: 'new-app', machineId: 'm2', syncAgentAddr: 'new-app.fly.dev:39201' }, flyClient);
    const newSession = mgr.sessions.get('w1');
    ok(newSession !== oldSession, 'session replaced on machine change');
    ok(oldSession.closed, 'old session closed');
    mgr.closeFor('w1');
  });

  t.test('closeFor closes and removes the session', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    const mgr = new FlySyncManager();
    const flyClient = fakeFlyClient();
    await mgr.push('w1', dir, { appName: 'app', machineId: 'm1', syncAgentAddr: 'app.fly.dev:39201' }, flyClient);
    const session = mgr.sessions.get('w1');
    mgr.closeFor('w1');
    ok(session.closed, 'session closed');
    eq(mgr.sessions.has('w1'), false, 'session removed from map');
  });
};
