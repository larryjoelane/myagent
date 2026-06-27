// Standalone diagnostic: push a local file/folder to a Fly machine's sync
// agent and report back what's actually running, without going through the
// Electron app at all. Use this to debug "https://<app>.fly.dev still
// doesn't load" — it prints the machine state, the public service mapping,
// the sync-agent health check, and the result of each file push.
//
// Requires FLY_API_TOKEN in the environment (or .env, loaded below).
//
// Usage:
//   node scripts/fly-push-test.js <appName> <localPath> [machineId]
//
// If machineId is omitted, the first machine found for the app is used.
// localPath is a file or folder pushed relative to its own root (folder) or
// its parent dir (file) — same semantics as /fly-push in the app.
//
// Examples:
//   node scripts/fly-push-test.js myexampleapp1 ./my-static-site
//   node scripts/fly-push-test.js myexampleapp1 ./index.html

require('dotenv').config();

const fs = require('fs');
const fs = require('fs');
const path = require('path');
const { FlyClient } = require('../src/core/fly/flyClient');
const { attachToSyncMachine, SYNC_AGENT_PORT, APP_INTERNAL_PORT } = require('../src/core/fly/flyBootstrap');
const { FlySyncSession } = require('../src/core/fly/flySyncClient');

function usageAndExit() {
  console.error('Usage: node scripts/fly-push-test.js <appName> <localPath> [machineId]');
  process.exit(1);
}

async function main() {
  const [appName, localPathArg, machineIdArg] = process.argv.slice(2);
  if (typeof localPathArg !== 'string' || localPathArg.trim() === '') {
    throw new Error('localPath must be a non-empty path string.');
  }
  if (!appName || !localPathArg) usageAndExit();
  const resolvedLocalPath = path.resolve(process.cwd(), localPathArg);
  let localPath;
  try {
    localPath = fs.realpathSync(resolvedLocalPath);
  } catch {
    throw new Error(`Local path does not exist or is not accessible: ${resolvedLocalPath}`);
  }
  const st = fs.statSync(localPath);
  if (!st.isFile() && !st.isDirectory()) {
    throw new Error(`Local path must be a file or directory: ${localPath}`);
  }

  const workspaceRoot = fs.realpathSync(process.cwd());
  const requestedPath = path.resolve(workspaceRoot, localPathArg);
  const localPath = fs.realpathSync(requestedPath);
  const insideWorkspace = localPath === workspaceRoot || localPath.startsWith(workspaceRoot + path.sep);
  if (!insideWorkspace) {
    throw new Error(`localPath must be inside the current working directory: ${workspaceRoot}`);
  }
  const localStat = fs.statSync(localPath);
  if (!localStat.isFile() && !localStat.isDirectory()) {
    throw new Error(`localPath must point to a file or directory: ${localPath}`);
  }

  console.log(`[1/5] Connecting to Fly app "${appName}"...`);

  const flyClient = new FlyClient();

  let machineId = machineIdArg;
  if (!machineId) {
    const machines = await flyClient.listMachines(appName);
    if (!Array.isArray(machines) || machines.length === 0) {
      throw new Error(`No machines found for app "${appName}". Has it been deployed/bootstrapped yet?`);
    }
    machineId = machines[0].id;
    console.log(`      Using first machine found: ${machineId} (state: ${machines[0].state})`);
  }

  console.log(`[2/5] Attaching to machine ${machineId} (starts it if stopped, injects sync agent if missing, fixes public service mapping if missing)...`);
  const info = await attachToSyncMachine(flyClient, appName, machineId);
  console.log('      ', info);

  if (!info.syncAgentAlreadyRunning) {
    console.log('      Sync agent was NOT running and has just been injected/started.');
  } else {
    console.log('      Sync agent already running.');
  }

  console.log(`[3/5] Checking machine config for public service on port ${APP_INTERNAL_PORT}...`);
  const machine = await flyClient.getMachine(appName, machineId);
  console.log('      machine.state =', machine.state);
  console.log('      machine.config.services =', JSON.stringify(machine.config && machine.config.services, null, 2));

  console.log(`[4/5] Pushing "${localPath}" to /app on the machine via sync agent (port ${SYNC_AGENT_PORT})...`);
  const session = new FlySyncSession({
    flyClient,
    appName,
    machineId,
    syncAgentPort: SYNC_AGENT_PORT,
    localRoot: localPath,
  });
  const pushed = await session.pushAll();
  console.log(`      Pushed ${pushed} file(s).`);

  console.log('[5/5] Done. Give it a few seconds for the app process to (re)start, then check:');
  console.log(`       ${info.url}`);
  console.log('      If it still 404s/fails to load, check the machine logs with:');
  console.log(`       fly logs -a ${appName}`);
  console.log('      or re-run this script — it will reuse the same machine and report current state.');
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.stack || err);
  process.exit(1);
});
