// One FlySyncSession per worker id. The first push for a given worker
// creates its session (pointed at that worker's current Fly deploy info)
// and pushes everything; later pushes reuse the session and start watching
// on the pushed root so subsequent local saves sync automatically.
//
// If the worker's machineId changes (e.g. a fresh deploy replaced the
// machine), the stale session is closed and a new one is created.
//
// Requires a FlyClient (passed in by the caller, via getFlyClient()) since
// pushes go over the Machines exec API, not a public HTTP call — see
// flySyncClient.js for why.

const { FlySyncSession } = require('./flySyncClient');
const { SYNC_AGENT_PORT } = require('./flyBootstrap');

class FlySyncManager {
  constructor() {
    /** @type {Map<string, FlySyncSession>} */
    this.sessions = new Map();
  }

  /**
   * @param {string} workerId
   * @param {string} absPath - file or folder to push and start watching
   * @param {{ appName: string, machineId: string, syncAgentAddr: string }} deployInfo
   * @param {import('./flyClient').FlyClient} flyClient
   */
  async push(workerId, absPath, deployInfo, flyClient) {
    let session = this.sessions.get(workerId);
    if (session && session.machineId !== deployInfo.machineId) {
      session.close();
      session = null;
    }
    if (!session || session.localRoot !== absPath) {
      if (session) session.close();
      session = new FlySyncSession({
        flyClient,
        appName: deployInfo.appName,
        machineId: deployInfo.machineId,
        syncAgentPort: SYNC_AGENT_PORT,
        localRoot: absPath,
      });
      this.sessions.set(workerId, session);
    }
    const count = await session.pushAll();
    session.startWatching();
    return { ok: true, pushed: count, watching: absPath, syncAgentAddr: deployInfo.syncAgentAddr };
  }

  closeFor(workerId) {
    const session = this.sessions.get(workerId);
    if (session) session.close();
    this.sessions.delete(workerId);
  }
}

module.exports = { FlySyncManager };
