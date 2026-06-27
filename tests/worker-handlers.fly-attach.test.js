// Focused tests for the worker:fly-list-machines and worker:fly-attach IPC
// handlers in electron/ipc/worker-handlers.js. Stubs getFlyClient +
// workerManager so no real Fly API calls happen.

const { register } = require('../electron/ipc/worker-handlers');
const { eq, contains } = require('./assert');

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
    attachFly: async () => ({ ok: true }),
    ...overrides.workerManager,
  };
  register({
    ipcMain,
    BrowserWindow: {},
    dialog: {},
    workerManager,
    appSettings: { get: () => null, set: () => {} },
    projectRoot: '/proj',
    flySync: overrides.flySync,
    getFlyClient: overrides.getFlyClient,
  });
  return { ipcMain, workerManager };
}

exports.run = (t) => {
  t.test('worker:fly-list-machines requires an appName', async () => {
    const { ipcMain } = baseDeps();
    const handler = ipcMain.handlers.get('worker:fly-list-machines');
    const result = await handler(null, {});
    eq(result.ok, false, 'fails without appName');
    contains(result.error, 'appName', 'error mentions appName');
  });

  t.test('worker:fly-list-machines fails cleanly with no FlyClient', async () => {
    const { ipcMain } = baseDeps({ getFlyClient: () => null });
    const handler = ipcMain.handlers.get('worker:fly-list-machines');
    const result = await handler(null, { appName: 'my-app' });
    eq(result.ok, false, 'fails');
    contains(result.error, 'FLY_API_TOKEN', 'reports missing token');
  });

  t.test('worker:fly-list-machines maps the client response to a thin shape', async () => {
    const { ipcMain } = baseDeps({
      getFlyClient: () => ({
        listMachines: async (appName) => {
          eq(appName, 'my-app', 'queries the right app');
          return [
            { id: 'm1', name: 'cozy-fox', state: 'started', region: 'iad', extra: 'ignored' },
            { id: 'm2', name: 'shy-owl', state: 'stopped', region: 'lhr' },
          ];
        },
      }),
    });
    const handler = ipcMain.handlers.get('worker:fly-list-machines');
    const result = await handler(null, { appName: 'my-app' });
    eq(result.ok, true, 'success');
    eq(result.machines.length, 2, 'two machines');
    eq(result.machines[0].id, 'm1');
    eq(result.machines[0].extra, undefined, 'drops unmapped fields');
  });

  t.test('worker:fly-list-machines surfaces a thrown error', async () => {
    const { ipcMain } = baseDeps({
      getFlyClient: () => ({ listMachines: async () => { throw new Error('api down'); } }),
    });
    const handler = ipcMain.handlers.get('worker:fly-list-machines');
    const result = await handler(null, { appName: 'my-app' });
    eq(result.ok, false, 'fails');
    contains(result.error, 'api down', 'surfaces underlying error');
  });

  t.test('worker:fly-attach rejects a non-string machineId', async () => {
    const { ipcMain } = baseDeps();
    const handler = ipcMain.handlers.get('worker:fly-attach');
    const result = await handler(null, { id: 'w1', machineId: 42 });
    eq(result.ok, false, 'fails with a non-string machineId');
    contains(result.error, 'machineId', 'error mentions machineId');
  });

  t.test('worker:fly-attach allows an omitted machineId (restart-sync path)', async () => {
    const calls = [];
    const { ipcMain } = baseDeps({
      workerManager: {
        attachFly: async (id, machineId) => { calls.push([id, machineId]); return { ok: true }; },
      },
    });
    const handler = ipcMain.handlers.get('worker:fly-attach');
    const result = await handler(null, { id: 'w1' });
    eq(result.ok, true, 'success');
    eq(calls[0][0], 'w1');
    eq(calls[0][1], undefined, 'machineId passed through as undefined — workerManager resolves the default');
  });

  t.test('worker:fly-attach delegates to workerManager.attachFly', async () => {
    const calls = [];
    const { ipcMain } = baseDeps({
      workerManager: {
        attachFly: async (id, machineId) => { calls.push([id, machineId]); return { ok: true }; },
      },
    });
    const handler = ipcMain.handlers.get('worker:fly-attach');
    const result = await handler(null, { id: 'w1', machineId: 'm1' });
    eq(result.ok, true, 'success');
    eq(calls.length, 1, 'one call');
    eq(calls[0][0], 'w1');
    eq(calls[0][1], 'm1');
  });

  t.test('worker:fly-attach surfaces a thrown error', async () => {
    const { ipcMain } = baseDeps({
      workerManager: { attachFly: async () => { throw new Error('attach blew up'); } },
    });
    const handler = ipcMain.handlers.get('worker:fly-attach');
    const result = await handler(null, { id: 'w1', machineId: 'm1' });
    eq(result.ok, false, 'fails');
    contains(result.error, 'attach blew up', 'surfaces underlying error');
  });

  t.test('worker:fly-check-sync delegates to workerManager.checkFlySync', async () => {
    const calls = [];
    const { ipcMain } = baseDeps({
      workerManager: {
        checkFlySync: async (id) => { calls.push(id); return { ok: true, running: true, machineState: 'started' }; },
      },
    });
    const handler = ipcMain.handlers.get('worker:fly-check-sync');
    const result = await handler(null, { id: 'w1' });
    eq(result.ok, true, 'success');
    eq(result.running, true);
    eq(calls[0], 'w1');
  });

  t.test('worker:fly-check-sync surfaces a thrown error', async () => {
    const { ipcMain } = baseDeps({
      workerManager: { checkFlySync: async () => { throw new Error('check blew up'); } },
    });
    const handler = ipcMain.handlers.get('worker:fly-check-sync');
    const result = await handler(null, { id: 'w1' });
    eq(result.ok, false, 'fails');
    contains(result.error, 'check blew up', 'surfaces underlying error');
  });
};
