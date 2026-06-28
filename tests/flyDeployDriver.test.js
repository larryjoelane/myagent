// FlyDeployDriver tests. Stubs flyClient so no real Fly API calls happen;
// asserts the chat:* event sequence for the happy path, the missing-token
// path, and a failing API call. send() delegates to bootstrapSyncMachine
// (flyBootstrap.js), which calls ensureApp -> createMachine -> waitForState
// -> exec (to inject the sync agent) in that order.

const { FlyDeployDriver } = require('../src/core/drivers/flyDeployDriver');
const { eq, ok, contains } = require('./assert');

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
  };
}

function fakeFlyClient({ failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    async ensureApp(appName) {
      calls.push(['ensureApp', appName]);
      if (failAt === 'ensureApp') throw new Error('ensureApp blew up');
      return { app_name: appName };
    },
    async listVolumes(appName) {
      calls.push(['listVolumes', appName]);
      if (failAt === 'listVolumes') throw new Error('listVolumes blew up');
      return [];
    },
    async createVolume(appName, name, opts) {
      calls.push(['createVolume', appName, name, opts]);
      if (failAt === 'createVolume') throw new Error('createVolume blew up');
      return { id: 'vol1', name };
    },
    async createMachine(appName, config, opts) {
      calls.push(['createMachine', appName, config, opts]);
      if (failAt === 'createMachine') throw new Error('createMachine blew up');
      return { id: 'm1', state: 'created' };
    },
    async waitForState(appName, machineId, targetState) {
      calls.push(['waitForState', appName, machineId, targetState]);
      if (failAt === 'waitForState') throw new Error('waitForState blew up');
      return { id: machineId, state: targetState };
    },
    async writeFileViaArgv(appName, machineId, remotePath, content, opts) {
      calls.push(['writeFileViaArgv', appName, machineId, remotePath, content, opts]);
      if (failAt === 'writeFileViaArgv') throw new Error('writeFileViaArgv blew up');
      return { exit_code: 0, stdout: '', stderr: '' };
    },
    async exec(appName, machineId, command, opts) {
      calls.push(['exec', appName, machineId, command, opts]);
      if (failAt === 'exec') throw new Error('exec blew up');
      return { exit_code: 0, stdout: '', stderr: '' };
    },
  };
}

exports.run = (t) => {
  t.test('send() bootstraps the sync machine and emits the URL on success', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient();
    const driver = new FlyDeployDriver({ agentId: 'f1', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.send('my-app');

    eq(r.countOf('chat:turn-end'), 1, 'one turn-end');
    eq(r.last('chat:user').payload.text, 'my-app', 'echoes app name');
    const chunk = r.last('chat:chunk');
    contains(chunk.payload.text, 'my-app', 'chunk mentions app name');
    contains(chunk.payload.text, 'my-app.fly.dev', 'chunk includes URL');
    contains(chunk.payload.text, 'fly-push', 'chunk mentions how to push code');
    eq(r.last('chat:turn-end').payload.ok, true, 'turn marked ok');

    eq(flyClient.calls[0][0], 'ensureApp', 'calls ensureApp first');
    eq(flyClient.calls[1][0], 'listVolumes', 'then checks for an existing volume');
    eq(flyClient.calls[2][0], 'createVolume', 'then creates one');
    eq(flyClient.calls[3][0], 'createMachine', 'then createMachine');
    eq(flyClient.calls[4][0], 'waitForState', 'then waitForState');
    eq(flyClient.calls[5][0], 'writeFileViaArgv', 'then writes the sync agent');
    eq(flyClient.calls[6][0], 'exec', 'then exec to start the sync agent');

    eq(driver.lastDeploy.appName, 'my-app', 'lastDeploy records app name');
    eq(driver.lastDeploy.machineId, 'm1', 'lastDeploy records machine id');
    ok(driver.lastDeploy.syncAgentAddr.includes('my-app.fly.dev'), 'lastDeploy records sync agent address');
  });

  t.test('send() falls back to defaultAppName when text is empty', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient();
    const driver = new FlyDeployDriver({
      agentId: 'f2', onEvent: r.onEvent, flyClient, defaultAppName: 'default-app',
    });
    await driver.start();
    await driver.send('');

    eq(r.last('chat:user').payload.text, 'default-app', 'uses default app name');
    eq(flyClient.calls[0][1], 'default-app', 'ensureApp called with default name');
  });

  t.test('send() emits chat:error with no flyClient and no defaultAppName', async () => {
    const r = recorder();
    const driver = new FlyDeployDriver({ agentId: 'f3', onEvent: r.onEvent, flyClient: null });
    await driver.start();
    await driver.send('');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'FLY_API_TOKEN', 'reports missing token');
    eq(r.countOf('chat:turn-end'), 0, 'no turn-end on missing-token path');
  });

  t.test('send() emits chat:error when no app name is available', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient();
    const driver = new FlyDeployDriver({ agentId: 'f4', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.send('');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'app name', 'reports missing app name');
  });

  t.test('send() emits chat:error and a failed turn-end when the Fly API call throws', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient({ failAt: 'createMachine' });
    const driver = new FlyDeployDriver({ agentId: 'f5', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.send('my-app');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'createMachine blew up', 'surfaces the underlying error');
    eq(r.countOf('chat:turn-end'), 1, 'still emits turn-end');
    eq(r.last('chat:turn-end').payload.ok, false, 'turn marked failed');
    eq(driver.lastDeploy, null, 'lastDeploy stays null on failure');
  });

  t.test('send() after close() emits chat:error', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient();
    const driver = new FlyDeployDriver({ agentId: 'f6', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.close();
    await driver.send('my-app');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'closed', 'reports closed state');
    eq(flyClient.calls.length, 0, 'no Fly API calls after close');
  });
};
