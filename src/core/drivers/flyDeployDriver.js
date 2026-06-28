// FlyDeployDriver — one-shot worker that boots a Fly Machine with a live
// sync agent on it and reports back the reachable URL. No streaming, no
// persistent process: each send() is a single bootstrap attempt.
//
// Input: the user's message text is the desired Fly app name. Empty text
// falls back to `defaultAppName` (the value configured in Settings).
//
// What happens on send(appName):
//   bootstrapSyncMachine(flyClient, appName, { region }) — see flyBootstrap.js:
//     1. ensureApp(appName)
//     2. ensureVolume(appName) — reuse or create the app's persistent volume
//     3. createMachine from a stock public image (node:20-slim), idling via
//        init.exec, with services for both the app port and the sync-agent
//        port, and the volume mounted at /app — no Dockerfile, no image
//        build/push, ever.
//     4. waitForState(..., 'started')
//     5. exec-inject the sync agent (writes + backgrounds it via a base64
//        argv — see FlyClient.writeFileViaArgv; exec stdin doesn't reliably
//        work on Fly's Machines API)
//
// The result (appName/machineId/syncAgentAddr) is stashed in `lastDeploy` so
// WorkerManager.getFlyDeployInfo() can hand it to the /fly-push command —
// that's how "the currently attached fly machine" gets resolved without
// the user having to copy a machine id around by hand.

const { bootstrapSyncMachine, attachToSyncMachine, checkSyncHealth } = require('../fly/flyBootstrap');

class FlyDeployDriver {
  // flyClient may be null (e.g. FLY_API_TOKEN unset) — checked lazily in
  // send() so a missing token surfaces as a chat:error, not a thrown
  // exception from the spawn path (mirrors how OpenAICompatibleDriver
  // handles a missing API key).
  constructor({ agentId, onEvent, flyClient, defaultAppName, region } = {}) {
    this.agentId = agentId;
    this.onEvent = onEvent || (() => {});
    this.flyClient = flyClient || null;
    this.defaultAppName = defaultAppName || null;
    this.region = region || 'iad';
    this.closed = false;
    // Last successful deploy, surfaced via WorkerManager.getFlyDeployInfo()
    // so the /fly-push command knows which app/machine to sync files to.
    this.lastDeploy = null;
  }

  async start() {
    // No persistent process — nothing to do.
  }

  async send(text) {
    if (this.closed) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'fly worker closed' });
      return;
    }
    if (!this.flyClient) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'FLY_API_TOKEN not set in .env' });
      return;
    }
    const appName = (text || '').trim() || this.defaultAppName;
    if (!appName) {
      this.onEvent('chat:error', {
        agentId: this.agentId,
        error: 'no Fly app name — set one in Settings or send a name to deploy',
      });
      return;
    }

    this.onEvent('chat:user', { agentId: this.agentId, text: appName });
    this.onEvent('chat:turn-start', { agentId: this.agentId });

    try {
      const deployed = await bootstrapSyncMachine(this.flyClient, appName, { region: this.region });
      this.lastDeploy = deployed;

      const body = `Machine ready: ${deployed.appName} (machine ${deployed.machineId}, region ${this.region}) — ${deployed.url}\n`
        + `Persistent volume attached at /app — pushed files survive machine stop/restart.\n`
        + `No app deployed yet — use \`/fly-push <file-or-folder>\` to send your code; it'll run automatically and live-sync on save.`;

      this.onEvent('chat:chunk', { agentId: this.agentId, kind: 'text', text: body });
      this.onEvent('chat:turn-end', {
        agentId: this.agentId,
        userText: appName,
        assistantText: body,
        ok: true,
        result: body,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.onEvent('chat:error', { agentId: this.agentId, error: message });
      this.onEvent('chat:turn-end', {
        agentId: this.agentId,
        userText: appName,
        assistantText: '',
        ok: false,
        result: message,
      });
    }
  }

  // Attaches to an already-existing machine (picked from the settings-drawer
  // dropdown) instead of creating a new one. Mirrors send()'s event sequence
  // so the chat surface looks the same either way, but skips ensureApp/
  // createMachine — see attachToSyncMachine in flyBootstrap.js.
  async attach(appName, machineId) {
    if (this.closed) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'fly worker closed' });
      return;
    }
    if (!this.flyClient) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'FLY_API_TOKEN not set in .env' });
      return;
    }
    const label = `attach ${appName}/${machineId}`;
    this.onEvent('chat:user', { agentId: this.agentId, text: label });
    this.onEvent('chat:turn-start', { agentId: this.agentId });

    try {
      const deployed = await attachToSyncMachine(this.flyClient, appName, machineId);
      this.lastDeploy = deployed;

      const body = `Attached: ${deployed.appName} (machine ${deployed.machineId}) — ${deployed.url}\n`
        + (deployed.syncAgentAlreadyRunning
          ? 'Sync agent already running.\n'
          : 'Sync agent injected and started.\n')
        + (deployed.hasVolume
          ? ''
          : 'Warning: this machine has no persistent volume — pushed files will be lost on the next stop/restart. Fly only supports attaching a volume at machine creation time, so fixing this means destroying and recreating the machine (e.g. via bootstrapSyncMachine).\n')
        + 'Use `/fly-push <file-or-folder>` to send your code; it\'ll live-sync on save.';

      this.onEvent('chat:chunk', { agentId: this.agentId, kind: 'text', text: body });
      this.onEvent('chat:turn-end', {
        agentId: this.agentId,
        userText: label,
        assistantText: body,
        ok: true,
        result: body,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.onEvent('chat:error', { agentId: this.agentId, error: message });
      this.onEvent('chat:turn-end', {
        agentId: this.agentId,
        userText: label,
        assistantText: '',
        ok: false,
        result: message,
      });
    }
  }

  // Pure status read for the last deploy/attach — no side effects (does not
  // start a stopped machine or inject anything). Surfaced via
  // WorkerManager.checkFlySync() so the UI can show a live/dead indicator on
  // the worker chip without the user having to push a file and find out the
  // hard way. `running: false` covers both "machine stopped" and "machine
  // started but sync agent isn't responding" — same fix either way (attach).
  async checkSync() {
    if (!this.flyClient || !this.lastDeploy) {
      return { ok: false, error: 'no Fly machine attached yet' };
    }
    const { appName, machineId } = this.lastDeploy;
    try {
      const machine = await this.flyClient.getMachine(appName, machineId);
      if (machine.state !== 'started') {
        return { ok: true, running: false, machineState: machine.state };
      }
      const running = await checkSyncHealth(this.flyClient, appName, machineId);
      return { ok: true, running, machineState: machine.state };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async close() {
    this.closed = true;
  }
}

module.exports = { FlyDeployDriver };
