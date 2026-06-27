// FlyDeployDriver.attach() tests — the "attach to existing machine"
// counterpart to send(). Stubs flyClient so no real Fly API calls happen.

const { FlyDeployDriver } = require('../src/core/drivers/flyDeployDriver');
const { buildInitExecCommand } = require('../src/core/fly/flyBootstrap');
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

function fakeFlyClient({ healthStdout = '200', failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    async getMachine(appName, machineId) {
      calls.push(['getMachine', appName, machineId]);
      if (failAt === 'getMachine') throw new Error('getMachine blew up');
      return {
        id: machineId, state: 'started', region: 'iad',
        config: {
          services: [{ protocol: 'tcp', internal_port: 8080, ports: [{ port: 443 }] }],
          init: { exec: buildInitExecCommand() },
        },
      };
    },
    async updateMachineConfig(appName, machineId, newConfig) {
      calls.push(['updateMachineConfig', appName, machineId, newConfig]);
      return { id: machineId, state: 'started', region: 'iad', config: newConfig };
    },
    async writeFileViaArgv(appName, machineId, remotePath, content, opts) {
      calls.push(['writeFileViaArgv', appName, machineId, remotePath, content, opts]);
      if (failAt === 'writeFileViaArgv') throw new Error('writeFileViaArgv blew up');
      return { exit_code: 0, stdout: '', stderr: '' };
    },
    async exec(appName, machineId, command, opts) {
      calls.push(['exec', appName, machineId, command, opts]);
      if (failAt === 'exec') throw new Error('exec blew up');
      if (command.join(' ').includes('/health')) return { exit_code: 0, stdout: healthStdout, stderr: '' };
      return { exit_code: 0, stdout: '', stderr: '' };
    },
  };
}

exports.run = (t) => {
  t.test('attach() attaches to an existing machine without creating one', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    const driver = new FlyDeployDriver({ agentId: 'f1', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.attach('my-app', 'm1');

    eq(r.countOf('chat:turn-end'), 1, 'one turn-end');
    eq(r.last('chat:turn-end').payload.ok, true, 'turn marked ok');
    const chunk = r.last('chat:chunk');
    contains(chunk.payload.text, 'Attached', 'chunk says attached');
    contains(chunk.payload.text, 'already running', 'chunk reports sync agent already running');

    eq(driver.lastDeploy.appName, 'my-app', 'lastDeploy records app name');
    eq(driver.lastDeploy.machineId, 'm1', 'lastDeploy records machine id');
    ok(!flyClient.calls.some((c) => c[0] === 'createMachine'), 'never creates a machine');
  });

  t.test('attach() reports injection when the sync agent was not already running', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient({ healthStdout: '000' });
    const driver = new FlyDeployDriver({ agentId: 'f2', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.attach('my-app', 'm1');

    const chunk = r.last('chat:chunk');
    contains(chunk.payload.text, 'injected', 'chunk reports injection');
  });

  t.test('attach() emits chat:error with no flyClient', async () => {
    const r = recorder();
    const driver = new FlyDeployDriver({ agentId: 'f3', onEvent: r.onEvent, flyClient: null });
    await driver.start();
    await driver.attach('my-app', 'm1');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'FLY_API_TOKEN', 'reports missing token');
  });

  t.test('attach() emits chat:error and failed turn-end when the Fly API call throws', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient({ failAt: 'getMachine' });
    const driver = new FlyDeployDriver({ agentId: 'f4', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.attach('my-app', 'm1');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'getMachine blew up', 'surfaces underlying error');
    eq(r.last('chat:turn-end').payload.ok, false, 'turn marked failed');
    eq(driver.lastDeploy, null, 'lastDeploy stays null on failure');
  });

  t.test('attach() after close() emits chat:error', async () => {
    const r = recorder();
    const flyClient = fakeFlyClient();
    const driver = new FlyDeployDriver({ agentId: 'f5', onEvent: r.onEvent, flyClient });
    await driver.start();
    await driver.close();
    await driver.attach('my-app', 'm1');

    eq(r.countOf('chat:error'), 1, 'one error');
    contains(r.last('chat:error').payload.error, 'closed', 'reports closed state');
    eq(flyClient.calls.length, 0, 'no Fly API calls after close');
  });
};
