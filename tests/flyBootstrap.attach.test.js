// attachToSyncMachine tests — the "attach to an existing machine" sibling
// of bootstrapSyncMachine. Asserts it skips ensureApp/createMachine, checks
// health via exec before deciding whether to inject, only injects when the
// health check fails, and reports whether the machine has a volume mounted
// (it cannot retrofit one — Fly only accepts `mounts` at createMachine time).

const { attachToSyncMachine, buildInitExecCommand, SYNC_AGENT_PORT, APP_INTERNAL_PORT, APP_VOLUME_PATH } = require('../src/core/fly/flyBootstrap');
const { SYNC_AGENT_SOURCE } = require('../src/core/fly/syncAgentSource');
const { eq, ok } = require('./assert');

const PUBLIC_SERVICES = [
  { protocol: 'tcp', internal_port: APP_INTERNAL_PORT, ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'] }] },
  { protocol: 'tcp', internal_port: SYNC_AGENT_PORT, ports: [{ port: SYNC_AGENT_PORT }] },
];

const SELF_STARTING_INIT = { exec: buildInitExecCommand() };

function fakeFlyClient({ healthStdout = '', execExitCode = 0, initialState = 'started', services = PUBLIC_SERVICES, mounts, init = SELF_STARTING_INIT } = {}) {
  const calls = [];
  let state = initialState;
  let config = { services, init, ...(mounts !== undefined ? { mounts } : {}) };
  return {
    calls,
    async getMachine(appName, machineId) {
      calls.push(['getMachine', appName, machineId]);
      return { id: machineId, state, region: 'iad', config };
    },
    async startMachine(appName, machineId) {
      calls.push(['startMachine', appName, machineId]);
      state = 'started';
    },
    async updateMachineConfig(appName, machineId, newConfig) {
      calls.push(['updateMachineConfig', appName, machineId, newConfig]);
      config = newConfig;
      state = 'started';
    },
    async waitForState(appName, machineId, targetState) {
      calls.push(['waitForState', appName, machineId, targetState]);
      return { id: machineId, state, region: 'iad', config };
    },
    async writeFileViaArgv(appName, machineId, remotePath, content, opts) {
      calls.push(['writeFileViaArgv', appName, machineId, remotePath, content, opts]);
      return { exit_code: 0, stdout: '', stderr: '' };
    },
    async exec(appName, machineId, command, opts) {
      const isHealthCheck = command.join(' ').includes('/health');
      calls.push(['exec', appName, machineId, command, opts]);
      if (isHealthCheck) return { exit_code: 0, stdout: healthStdout, stderr: '' };
      return { exit_code: execExitCode, stdout: '', stderr: execExitCode ? 'boom' : '' };
    },
  };
}

exports.run = (t) => {
  t.test('attachToSyncMachine never creates a machine — only getMachine + exec', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    await attachToSyncMachine(flyClient, 'my-app', 'm1');

    eq(flyClient.calls[0][0], 'getMachine', 'getMachine first');
    ok(!flyClient.calls.some((c) => c[0] === 'ensureApp' || c[0] === 'createMachine'),
      'never calls ensureApp/createMachine');
  });

  t.test('attachToSyncMachine skips injection when the health check reports running', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');

    const execCalls = flyClient.calls.filter((c) => c[0] === 'exec');
    eq(execCalls.length, 1, 'only the health-check exec runs');
    eq(result.syncAgentAlreadyRunning, true, 'result reports already running');
    eq(result.attached, true, 'result is marked attached');
  });

  t.test('attachToSyncMachine injects the sync agent via writeFileViaArgv when health check fails', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '000' });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');

    const writeCall = flyClient.calls.find((c) => c[0] === 'writeFileViaArgv');
    ok(writeCall, 'calls writeFileViaArgv to deliver the agent source');
    eq(writeCall[3], '/agent.js', 'writes to /agent.js');
    eq(writeCall[4], SYNC_AGENT_SOURCE, 'content is the full agent source');

    const execCalls = flyClient.calls.filter((c) => c[0] === 'exec');
    eq(execCalls.length, 2, 'health check, then the start-agent exec');
    eq(result.syncAgentAlreadyRunning, false, 'result reports it was not already running');
  });

  t.test('attachToSyncMachine reports hasVolume: true when the machine already has the app volume mounted', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', mounts: [{ volume: 'vol1', path: APP_VOLUME_PATH }] });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');
    eq(result.hasVolume, true, 'reports the existing volume mount');
  });

  t.test('attachToSyncMachine reports hasVolume: false when the machine has no volume mounted', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', mounts: [] });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');
    eq(result.hasVolume, false, 'reports no volume mount — cannot be retrofitted onto this machine');
  });

  t.test('attachToSyncMachine reports hasVolume: false when config.mounts is absent entirely', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');
    eq(result.hasVolume, false, 'absent mounts means no volume');
  });

  t.test('attachToSyncMachine returns the same shape as bootstrapSyncMachine', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');

    eq(result.appName, 'my-app', 'carries app name');
    eq(result.machineId, 'm1', 'carries machine id');
    ok(result.url.includes('my-app.fly.dev'), 'carries public url');
    ok(result.syncAgentAddr.includes(String(SYNC_AGENT_PORT)), 'carries sync agent address');
  });

  t.test('attachToSyncMachine throws when injection exec fails', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '000', execExitCode: 1 });
    let caught = null;
    try {
      await attachToSyncMachine(flyClient, 'my-app', 'm1');
    } catch (err) { caught = err; }
    ok(caught, 'throws on nonzero exit code');
    ok(caught.message.includes('exit 1'), 'message includes exit code');
  });

  t.test('attachToSyncMachine starts a stopped machine before any exec call', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', initialState: 'stopped' });
    await attachToSyncMachine(flyClient, 'my-app', 'm1');

    eq(flyClient.calls[0][0], 'getMachine', 'getMachine first');
    eq(flyClient.calls[1][0], 'startMachine', 'startMachine when not started');
    eq(flyClient.calls[2][0], 'waitForState', 'waits for started');
    eq(flyClient.calls[2][3], 'started', 'waits specifically for started');
    eq(flyClient.calls[3][0], 'exec', 'exec only runs after the machine is started');
  });

  t.test('attachToSyncMachine skips startMachine when already started', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', initialState: 'started' });
    await attachToSyncMachine(flyClient, 'my-app', 'm1');

    ok(!flyClient.calls.some((c) => c[0] === 'startMachine'),
      'no startMachine call when already started');
  });

  t.test('attachToSyncMachine patches in a public service mapping when missing', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', services: [] });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');

    const updateCall = flyClient.calls.find((c) => c[0] === 'updateMachineConfig');
    ok(updateCall, 'calls updateMachineConfig');
    const newServices = updateCall[3].services;
    ok(newServices.some((s) => s.internal_port === APP_INTERNAL_PORT && s.ports.some((p) => p.port === 443)),
      'patched config maps a public port to the app port');
    ok(result.attached, 'still reports attached');
  });

  t.test('attachToSyncMachine skips updateMachineConfig when a public service mapping already exists', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    await attachToSyncMachine(flyClient, 'my-app', 'm1');

    ok(!flyClient.calls.some((c) => c[0] === 'updateMachineConfig'),
      'no updateMachineConfig call when the mapping already exists');
  });

  t.test('attachToSyncMachine re-waits for started after patching the service mapping', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', services: [] });
    await attachToSyncMachine(flyClient, 'my-app', 'm1');

    const updateIdx = flyClient.calls.findIndex((c) => c[0] === 'updateMachineConfig');
    const waitIdx = flyClient.calls.findIndex((c, i) => i > updateIdx && c[0] === 'waitForState');
    ok(updateIdx >= 0 && waitIdx > updateIdx, 'waits for started again after the config update');
  });

  t.test('attachToSyncMachine patches init.exec to the self-starting app launcher on a legacy machine', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200', init: { exec: ['sleep', 'infinity'] } });
    const result = await attachToSyncMachine(flyClient, 'my-app', 'm1');

    const updateCall = flyClient.calls.find((c) => c[0] === 'updateMachineConfig');
    ok(updateCall, 'calls updateMachineConfig to upgrade the legacy idle command');
    eq(updateCall[3].init.exec[0], 'sh', 'patched init.exec runs the app-launcher script');
    ok(result.attached, 'still reports attached');
  });

  t.test('attachToSyncMachine skips updateMachineConfig when init.exec is already self-starting and services are fine', async () => {
    const flyClient = fakeFlyClient({ healthStdout: '200' });
    await attachToSyncMachine(flyClient, 'my-app', 'm1');

    ok(!flyClient.calls.some((c) => c[0] === 'updateMachineConfig'),
      'no updateMachineConfig call when nothing needs patching');
  });
};
