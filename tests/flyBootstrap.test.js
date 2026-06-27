// flyBootstrap tests. Stubs FlyClient methods; asserts the machine config
// shape (stock image + idling init.exec + services for both ports + the
// app's persistent volume mount) and the exec call that injects the sync
// agent.

const { bootstrapSyncMachine, buildInitExecCommand, hasSelfStartingInit, BASE_IMAGE, SYNC_AGENT_PORT, APP_INTERNAL_PORT, APP_VOLUME_PATH, volumeNameForApp } = require('../src/core/fly/flyBootstrap');
const { SYNC_AGENT_SOURCE } = require('../src/core/fly/syncAgentSource');
const { eq, ok, deepEq } = require('./assert');

function fakeFlyClient({ execExitCode = 0, existingVolumes = [] } = {}) {
  const calls = [];
  return {
    calls,
    async ensureApp(appName) {
      calls.push(['ensureApp', appName]);
      return { app_name: appName };
    },
    async listVolumes(appName) {
      calls.push(['listVolumes', appName]);
      return existingVolumes;
    },
    async createVolume(appName, name, opts) {
      calls.push(['createVolume', appName, name, opts]);
      return { id: 'vol1', name };
    },
    async createMachine(appName, config, opts) {
      calls.push(['createMachine', appName, config, opts]);
      return { id: 'm1' };
    },
    async waitForState(appName, machineId, targetState) {
      calls.push(['waitForState', appName, machineId, targetState]);
      return { id: machineId, state: targetState };
    },
    async writeFileViaArgv(appName, machineId, remotePath, content, opts) {
      calls.push(['writeFileViaArgv', appName, machineId, remotePath, content, opts]);
      return { exit_code: 0, stdout: '', stderr: '' };
    },
    async exec(appName, machineId, command, opts) {
      calls.push(['exec', appName, machineId, command, opts]);
      return { exit_code: execExitCode, stdout: '', stderr: execExitCode ? 'boom' : '' };
    },
  };
}

exports.run = (t) => {
  t.test('bootstrapSyncMachine creates a stock-image machine with idling init, both services, and a volume mount', async () => {
    const flyClient = fakeFlyClient();
    await bootstrapSyncMachine(flyClient, 'my-app', { region: 'iad' });

    eq(flyClient.calls[0][0], 'ensureApp', 'ensureApp first');
    eq(flyClient.calls[1][0], 'listVolumes', 'checks for an existing volume next');
    eq(flyClient.calls[2][0], 'createVolume', 'creates one when none exists');

    const createCall = flyClient.calls[3];
    eq(createCall[0], 'createMachine', 'createMachine after the volume is ready');
    const config = createCall[2];
    eq(config.image, BASE_IMAGE, 'uses the stock base image');
    ok(hasSelfStartingInit(config.init), 'init.exec self-starts the app launcher, independent of the sync agent');
    deepEq(config.init, { exec: buildInitExecCommand() }, 'init.exec matches buildInitExecCommand exactly');
    eq(config.services.length, 2, 'declares both app and sync-agent services');
    eq(config.services[0].internal_port, APP_INTERNAL_PORT, 'first service is the app port');
    eq(config.services[1].internal_port, SYNC_AGENT_PORT, 'second service is the sync-agent port');
    deepEq(config.mounts, [{ volume: 'vol1', path: APP_VOLUME_PATH }], 'mounts the app volume at APP_VOLUME_PATH');

    eq(flyClient.calls[4][0], 'waitForState', 'waitForState after createMachine');
  });

  t.test('bootstrapSyncMachine reuses an existing volume instead of creating a new one', async () => {
    const flyClient = fakeFlyClient({ existingVolumes: [{ id: 'vol-existing', name: volumeNameForApp('my-app') }] });
    await bootstrapSyncMachine(flyClient, 'my-app', { region: 'iad' });

    ok(!flyClient.calls.some((c) => c[0] === 'createVolume'), 'does not create a new volume');
    const createCall = flyClient.calls.find((c) => c[0] === 'createMachine');
    deepEq(createCall[2].mounts, [{ volume: 'vol-existing', path: APP_VOLUME_PATH }], 'mounts the reused volume');
  });

  t.test('bootstrapSyncMachine injects the sync agent via writeFileViaArgv, not exec stdin', async () => {
    const flyClient = fakeFlyClient();
    const result = await bootstrapSyncMachine(flyClient, 'my-app', { region: 'iad' });

    const writeCall = flyClient.calls.find((c) => c[0] === 'writeFileViaArgv');
    ok(writeCall, 'calls writeFileViaArgv to deliver the agent source');
    eq(writeCall[1], 'my-app', 'targets the right app');
    eq(writeCall[2], 'm1', 'targets the right machine');
    eq(writeCall[3], '/agent.js', 'writes to /agent.js');
    eq(writeCall[4], SYNC_AGENT_SOURCE, 'content is the full agent source');

    const execCall = flyClient.calls.find((c) => c[0] === 'exec');
    ok(execCall[4] === undefined || execCall[4].stdin === undefined, 'the start-agent exec call carries no stdin');
    ok(execCall[3].join(' ').includes('agent.js'), 'command starts agent.js');

    eq(result.appName, 'my-app', 'result carries app name');
    eq(result.machineId, 'm1', 'result carries machine id');
    eq(result.hasVolume, true, 'result reports a volume is attached');
    eq(result.volumeId, 'vol1', 'result carries the volume id');
    ok(result.url.includes('my-app.fly.dev'), 'result carries the public url');
    ok(result.syncAgentAddr.includes(String(SYNC_AGENT_PORT)), 'result carries sync agent address');
  });

  t.test('bootstrapSyncMachine throws when the injection exec fails', async () => {
    const flyClient = fakeFlyClient({ execExitCode: 1 });
    let caught = null;
    try {
      await bootstrapSyncMachine(flyClient, 'my-app');
    } catch (err) { caught = err; }
    ok(caught, 'throws on nonzero exit code');
    ok(caught.message.includes('exit 1'), 'message includes exit code');
  });
};
