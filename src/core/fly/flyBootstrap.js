// Zero-Docker bootstrap: launches a Fly machine from a stock public image
// (no build/push step — Fly pulls it directly), with the deployed app
// self-starting on every boot via init.exec — independent of MyAgent and
// independent of the sync agent. The sync agent (live file push while
// editing in MyAgent) is a separate, optional thing layered on top via
// exec-injection (attachToSyncMachine) — see syncAgentSource.js.
//
// Flow:
//   1. ensureApp(appName)
//   2. ensureVolume(appName) — reuse the app's persistent volume if one
//      already exists, else create a fresh one. /app lives on this volume,
//      so pushed files survive machine stop/restart/recreate.
//   3. createMachine from BASE_IMAGE, with `init.exec` set to
//      APP_LAUNCHER_INIT_EXEC (below) — a tiny embedded script that
//      detects and runs /app's start command (same detection rules as the
//      sync agent: npm start / index.js / server.js / app.py / static
//      index.html), restarting it if it crashes. This runs as PID 1's
//      child on EVERY boot — fresh create, Fly auto-wake from idle-stop,
//      and a manual dashboard restart alike — so the app comes back with
//      zero involvement from MyAgent or the sync agent.
//      `services` declares both the sync-agent port (internal use only,
//      reached via exec/SSH-style access — not public, and only live once
//      MyAgent attaches the sync agent) and the app's public port, and
//      `mounts` attaches the volume at /app.
//   4. waitForState(..., 'started')
//
// Returns { appName, machineId, region, url } so the caller (the fly-push
// command / sync client) knows where to push files.
//
// attachToSyncMachine() is the sibling entry point for the SYNC AGENT only
// — it injects/restarts the MyAgent-side live-push agent on an already-
// running machine (skips ensureApp/createMachine entirely), independent of
// whether the app itself is already up via its own init.exec. It CANNOT
// retrofit a volume mount onto that machine — Fly only accepts `mounts` at
// createMachine() time (confirmed by testing: the identical mounts entry
// that updateMachineConfig() rejects with "volume does not exist" succeeds
// fine on createMachine()). If the attached machine has no volume,
// attachToSyncMachine() reports that via `hasVolume: false` instead of
// silently risking data loss; the caller decides whether to recreate.

const { SYNC_AGENT_SOURCE } = require('./syncAgentSource');

const BASE_IMAGE = 'node:20-slim';
const SYNC_AGENT_PORT = 39201;
const APP_INTERNAL_PORT = 8080;
const APP_VOLUME_PATH = '/app';

// Standalone app launcher — detects /app's start command and runs it,
// restarting on crash. Zero overlap with the sync agent: no HTTP listener,
// no file-push endpoint, nothing MyAgent-shaped. Deliberately duplicates
// the sync agent's detectStartCommand()/runInstall() logic (rather than
// sharing code) because this script has to survive as a literal embedded
// string baked into init.exec — it can't require() a sibling module, since
// nothing else is ever copied onto the machine for it.
const APP_LAUNCHER_SOURCE = `
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const APP_DIR = '/app';

const STATIC_SERVER_SCRIPT = [
  'const http=require("http"),fs=require("fs"),path=require("path");',
  'const DIR=process.cwd();',
  'const TYPES={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml"};',
  'http.createServer((req,res)=>{',
  '  let p=path.normalize(path.join(DIR,decodeURIComponent(req.url.split("?")[0])));',
  '  if(!p.startsWith(DIR)){res.writeHead(403);res.end();return;}',
  '  if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p=path.join(p,"index.html");',
  '  fs.readFile(p,(err,data)=>{',
  '    if(err){res.writeHead(404);res.end("not found");return;}',
  '    res.writeHead(200,{"Content-Type":TYPES[path.extname(p)]||"application/octet-stream"});',
  '    res.end(data);',
  '  });',
  '}).listen(process.env.PORT||8080);',
].join('');

function detectStartCommand() {
  const pkgPath = path.join(APP_DIR, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.start) return ['npm', ['start']];
    } catch {}
  }
  if (fs.existsSync(path.join(APP_DIR, 'index.js'))) return ['node', ['index.js']];
  if (fs.existsSync(path.join(APP_DIR, 'server.js'))) return ['node', ['server.js']];
  if (fs.existsSync(path.join(APP_DIR, 'app.py'))) return ['python3', ['app.py']];
  if (fs.existsSync(path.join(APP_DIR, 'index.html'))) return ['node', ['-e', STATIC_SERVER_SCRIPT]];
  return null;
}

function maybeInstall() {
  const pkgPath = path.join(APP_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  if (fs.existsSync(path.join(APP_DIR, 'node_modules'))) return;
  console.log('[app-launcher] running npm install');
  spawnSync('npm', ['install'], { cwd: APP_DIR, stdio: 'inherit' });
}

function waitForApp() {
  return new Promise((resolve) => {
    const check = () => {
      if (detectStartCommand()) { resolve(); return; }
      setTimeout(check, 2000);
    };
    check();
  });
}

async function main() {
  console.log('[app-launcher] waiting for app files in', APP_DIR);
  await waitForApp();
  maybeInstall();
  for (;;) {
    const cmd = detectStartCommand();
    if (!cmd) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    const [bin, args] = cmd;
    console.log('[app-launcher] starting:', bin, args.join(' '));
    const exitCode = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: APP_DIR, stdio: 'inherit', env: { ...process.env, PORT: process.env.APP_PORT || '8080' } });
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(1));
    });
    console.log('[app-launcher] app exited', exitCode, '- restarting in 2s');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main();
`.trim();

// init.exec command for the standalone app launcher above — writes it to
// /app-launcher.js from a base64 argv (avoids the broken exec-stdin path
// and shell-quoting issues — same trick as FlyClient.writeFileViaArgv) then
// execs node directly as PID 1's child, so the launcher process itself is
// what the machine considers "the" running process (matching how
// `sleep infinity` used to be the foreground command on older machines).
// Rewritten to disk on every boot, so an old copy never goes stale across
// MyAgent version upgrades.
const APP_LAUNCHER_PATH = '/app-launcher.js';
function buildInitExecCommand() {
  const b64 = Buffer.from(APP_LAUNCHER_SOURCE, 'utf8').toString('base64');
  return [
    'sh', '-c',
    `node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"))' '${APP_LAUNCHER_PATH}' '${b64}' && exec node ${APP_LAUNCHER_PATH}`,
  ];
}

// True when a machine's init.exec is already the self-starting app-launcher
// command (vs. the legacy `["sleep","infinity"]` idle command from before
// this fix, which needs a one-time patch via updateMachineConfig).
function hasSelfStartingInit(init) {
  return Array.isArray(init && init.exec)
    && init.exec[0] === 'sh'
    && typeof init.exec[2] === 'string'
    && init.exec[2].includes(APP_LAUNCHER_PATH);
}

// Fly volume names: lowercase alphanumeric + underscores only, max 30 chars
// (confirmed via API error message). One volume per app, named after it, so
// bootstrapSyncMachine can find and reuse it across machine recreates.
function volumeNameForApp(appName) {
  return `myagent_${appName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30);
}

async function ensureVolume(flyClient, appName, region) {
  const name = volumeNameForApp(appName);
  const existing = await flyClient.listVolumes(appName);
  const found = Array.isArray(existing) && existing.find((v) => v.name === name);
  if (found) return found;
  return flyClient.createVolume(appName, name, { region, sizeGb: 1 });
}

function buildServices() {
  return [
    {
      protocol: 'tcp',
      internal_port: APP_INTERNAL_PORT,
      ports: [
        { port: 443, handlers: ['tls', 'http'] },
        { port: 80, handlers: ['http'] },
      ],
    },
    {
      protocol: 'tcp',
      internal_port: SYNC_AGENT_PORT,
      ports: [{ port: SYNC_AGENT_PORT }],
    },
  ];
}

// True when `services` already has a service forwarding some public port to
// APP_INTERNAL_PORT — i.e. the public URL has somewhere to route to.
function hasPublicAppService(services) {
  return Array.isArray(services) && services.some((s) =>
    s.internal_port === APP_INTERNAL_PORT
    && Array.isArray(s.ports)
    && s.ports.some((p) => p.port === 443 || p.port === 80));
}

// Pure read: true when the sync agent answers 200 on its in-machine /health
// endpoint right now. Used both by attachToSyncMachine (decide whether to
// inject) and standalone by callers that just want a status check without
// the side effects (start/patch/inject) attachToSyncMachine may perform.
// Does NOT start a stopped machine — exec() 412s on one, so a stopped
// machine just reads as "not running" rather than throwing.
async function checkSyncHealth(flyClient, appName, machineId) {
  const healthScript = `
    const http = require('http');
    const req = http.get({ host: 'localhost', port: ${SYNC_AGENT_PORT}, path: '/health', timeout: 5000 }, (res) => {
      process.stdout.write(String(res.statusCode));
      res.resume();
    });
    req.on('error', () => process.stdout.write('0'));
    req.on('timeout', () => { req.destroy(); process.stdout.write('0'); });
  `;
  try {
    const health = await flyClient.exec(
      appName,
      machineId,
      ['node', '-e', healthScript],
      { timeout: 10 },
    );
    return (health.stdout || '').trim() === '200';
  } catch {
    return false;
  }
}

async function bootstrapSyncMachine(flyClient, appName, { region = 'iad' } = {}) {
  await flyClient.ensureApp(appName);
  const volume = await ensureVolume(flyClient, appName, region);

  const machine = await flyClient.createMachine(appName, {
    image: BASE_IMAGE,
    init: { exec: buildInitExecCommand() },
    env: { APP_PORT: String(APP_INTERNAL_PORT) },
    services: buildServices(),
    mounts: [{ volume: volume.id, path: APP_VOLUME_PATH }],
  }, { region });

  const started = await flyClient.waitForState(appName, machine.id, 'started');

  await flyClient.writeFileViaArgv(appName, started.id, '/agent.js', SYNC_AGENT_SOURCE, { timeout: 30 });
  const result = await flyClient.exec(
    appName,
    started.id,
    ['sh', '-c', `nohup node /agent.js > /agent.log 2>&1 &`],
    { timeout: 30 },
  );
  if (result.exit_code) {
    throw new Error(`sync agent bootstrap failed (exit ${result.exit_code}): ${result.stderr || result.stdout}`);
  }

  return {
    appName,
    machineId: started.id,
    region,
    url: `https://${appName}.fly.dev`,
    syncAgentAddr: `${appName}.fly.dev:${SYNC_AGENT_PORT}`,
    hasVolume: true,
    volumeId: volume.id,
  };
}

// Attaches to a machine that already exists (created by MyAgent earlier, or
// by any other means) instead of creating a new one. Checks whether the
// sync agent is already running via an in-machine HTTP request to localhost
// (exec, not a public network call — the sync-agent port has no public
// handlers) and only injects it if that check fails. Uses `node -e` rather
// than curl, since curl isn't installed on BASE_IMAGE (node:20-slim).
//
// exec() 412s ("precondition failed") on a machine that isn't in the
// "started" state — a stopped/suspended/transitioning machine can't run
// commands. So a non-started machine is auto-started and waited on before
// any exec call, mirroring what createMachine + waitForState does on the
// bootstrap path.
//
// A machine attached this way may also have been created (by MyAgent or by
// hand) without a public service mapping for APP_INTERNAL_PORT — in which
// case the app's https://appName.fly.dev URL has nothing to route to and
// looks like "site can't be found" even once the app itself is running.
// Fly only supports whole-config updates (no partial PATCH), and an update
// reboots a running machine, so this check/patch happens before the
// exec-based health check / injection, and the reboot is waited out the
// same way startMachine's reboot is.
//
// Also patches init.exec to the self-starting app-launcher command (see
// buildInitExecCommand above) if the machine still has the legacy
// `["sleep","infinity"]` idle command — this is what makes the app survive
// future restarts/auto-wakes with zero MyAgent involvement, for a machine
// that was created before this fix existed. New machines from
// bootstrapSyncMachine already have it, so this is a one-time, idempotent
// upgrade path for older ones.
async function attachToSyncMachine(flyClient, appName, machineId) {
  let machine = await flyClient.getMachine(appName, machineId);
  if (machine.state !== 'started') {
    await flyClient.startMachine(appName, machineId);
    machine = await flyClient.waitForState(appName, machineId, 'started');
  }

  const needsServicePatch = !hasPublicAppService(machine.config && machine.config.services);
  const needsInitPatch = !hasSelfStartingInit(machine.config && machine.config.init);
  if (needsServicePatch || needsInitPatch) {
    await flyClient.updateMachineConfig(appName, machineId, {
      ...machine.config,
      services: buildServices(),
      init: { ...machine.config.init, exec: buildInitExecCommand() },
    }, { region: machine.region });
    machine = await flyClient.waitForState(appName, machineId, 'started');
  }

  const alreadyRunning = await checkSyncHealth(flyClient, appName, machineId);

  if (!alreadyRunning) {
    await flyClient.writeFileViaArgv(appName, machineId, '/agent.js', SYNC_AGENT_SOURCE, { timeout: 30 });
    const result = await flyClient.exec(
      appName,
      machineId,
      ['sh', '-c', `nohup node /agent.js > /agent.log 2>&1 &`],
      { timeout: 30 },
    );
    if (result.exit_code) {
      throw new Error(`sync agent inject failed (exit ${result.exit_code}): ${result.stderr || result.stdout}`);
    }
  }

  const hasVolume = Array.isArray(machine.config && machine.config.mounts)
    && machine.config.mounts.some((m) => m.path === APP_VOLUME_PATH);

  return {
    appName,
    machineId,
    region: machine.region,
    url: `https://${appName}.fly.dev`,
    syncAgentAddr: `${appName}.fly.dev:${SYNC_AGENT_PORT}`,
    attached: true,
    syncAgentAlreadyRunning: alreadyRunning,
    hasVolume,
  };
}

module.exports = {
  bootstrapSyncMachine,
  attachToSyncMachine,
  checkSyncHealth,
  buildInitExecCommand,
  hasSelfStartingInit,
  BASE_IMAGE,
  SYNC_AGENT_PORT,
  APP_INTERNAL_PORT,
  APP_VOLUME_PATH,
  APP_LAUNCHER_PATH,
  volumeNameForApp,
};
