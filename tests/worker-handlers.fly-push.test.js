// Focused tests for the worker:fly-push IPC handler in
// electron/ipc/worker-handlers.js. Stubs workerManager + flySync so no real
// Fly machine or filesystem access happens.

const { register } = require('../electron/ipc/worker-handlers');
const { eq, ok ,contains } = require('./assert');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
  };
}

function baseDeps(overrides = {}) {
  const ipcMain = fakeIpcMain();
  const workerManager = {
    getFlyDeployInfo: () => null,
    ...overrides.workerManager,
  };
  const flySync = overrides.flySync;
  register({
    ipcMain,
    BrowserWindow: {},
    dialog: {},
    workerManager,
    appSettings: { get: () => null, set: () => {} },
    projectRoot: '/proj',
    flySync,
  });
  return { ipcMain, workerManager, flySync };
}

exports.run = (t) => {
  t.test('worker:fly-push requires a path', async () => {
    const { ipcMain } = baseDeps();
    const handler = ipcMain.handlers.get('worker:fly-push');
    const result = await handler(null, { id: 'w1' });
    eq(result.ok, false, 'fails without a path');
    contains(result.error, 'path', 'error mentions path');
  });

  t.test('worker:fly-push fails when the worker has no Fly deploy info', async () => {
    const { ipcMain } = baseDeps({ workerManager: { getFlyDeployInfo: () => null } });
    const handler = ipcMain.handlers.get('worker:fly-push');
    const result = await handler(null, { id: 'w1', path: '/some/file.js' });
    eq(result.ok, false, 'fails with no deploy');
    contains(result.error, 'Fly machine', 'error explains no machine attached');
  });

  t.test('worker:fly-push fails cleanly when flySync is not provided', async () => {
    const { ipcMain } = baseDeps({
      workerManager: { getFlyDeployInfo: () => ({ syncAgentAddr: 'app.fly.dev:39201' }) },
    });
    const handler = ipcMain.handlers.get('worker:fly-push');
    const result = await handler(null, { id: 'w1', path: '/some/file.js' });
    eq(result.ok, false, 'fails without flySync');
  });

  t.test('worker:fly-push delegates to flySync.push with the deploy info', async () => {
    const calls = [];
    const deployInfo = { syncAgentAddr: 'app.fly.dev:39201', appName: 'app' };
    const { ipcMain } = baseDeps({
      workerManager: { getFlyDeployInfo: () => deployInfo },
      flySync: {
        push: async (id, path, info) => { calls.push([id, path, info]); return { ok: true, pushed: 3 }; },
      },
    });
    const handler = ipcMain.handlers.get('worker:fly-push');
    const result = await handler(null, { id: 'w1', path: '/some/folder' });

    eq(result.ok, true, 'success');
    eq(result.pushed, 3, 'returns flySync result');
    eq(calls.length, 1, 'one push call');
    eq(calls[0][0], 'w1', 'worker id forwarded');
    eq(calls[0][1], '/some/folder', 'path forwarded');
    eq(calls[0][2], deployInfo, 'deploy info forwarded');
  });

  t.test('worker:fly-push surfaces a thrown error from flySync.push', async () => {
    const { ipcMain } = baseDeps({
      workerManager: { getFlyDeployInfo: () => ({ syncAgentAddr: 'app.fly.dev:39201' }) },
      flySync: { push: async () => { throw new Error('agent unreachable'); } },
    });
    const handler = ipcMain.handlers.get('worker:fly-push');
    const result = await handler(null, { id: 'w1', path: '/some/file.js' });
    eq(result.ok, false, 'fails');
    contains(result.error, 'agent unreachable', 'surfaces underlying error');
  });

  t.test('worker:fly-push resolves a relative path against the given cwd', async () => {
    const calls = [];
    const { ipcMain } = baseDeps({
      workerManager: { getFlyDeployInfo: () => ({ syncAgentAddr: 'app.fly.dev:39201' }) },
      flySync: { push: async (id, path) => { calls.push(path); return { ok: true, pushed: 1 }; } },
    });
    const handler = ipcMain.handlers.get('worker:fly-push');
    await handler(null, { id: 'w1', path: 'myexampleapp', cwd: 'C:\\Users\\larry\\projects' });
    eq(calls[0], 'C:\\Users\\larry\\projects\\myexampleapp', 'resolved against the given cwd');
  });

  t.test('worker:fly-push leaves an absolute path untouched even when cwd is given', async () => {
    const calls = [];
    const { ipcMain } = baseDeps({
      workerManager: { getFlyDeployInfo: () => ({ syncAgentAddr: 'app.fly.dev:39201' }) },
      flySync: { push: async (id, path) => { calls.push(path); return { ok: true, pushed: 1 }; } },
    });
    const handler = ipcMain.handlers.get('worker:fly-push');
    await handler(null, { id: 'w1', path: 'C:\\Users\\larry\\elsewhere\\app', cwd: 'C:\\Users\\larry\\projects' });
    eq(calls[0], 'C:\\Users\\larry\\elsewhere\\app', 'absolute path is not re-resolved');
  });

  t.test('worker:fly-push falls back to projectRoot when no cwd is given', async () => {
    const calls = [];
    const { ipcMain } = baseDeps({
      workerManager: { getFlyDeployInfo: () => ({ syncAgentAddr: 'app.fly.dev:39201' }) },
      flySync: { push: async (id, path) => { calls.push(path); return { ok: true, pushed: 1 }; } },
    });
    const handler = ipcMain.handlers.get('worker:fly-push');
    await handler(null, { id: 'w1', path: 'myexampleapp' });
    eq(calls[0], require('path').resolve('/proj', 'myexampleapp'), 'falls back to the injected projectRoot');
  });
};
