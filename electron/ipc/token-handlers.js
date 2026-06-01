// IPC handlers for the token ledger surface:
//   tokens:snapshot     — full rollup (totals, by-provider, by-model, by-agent)
//   tokens:by-worker    — single agent's tallies
//   tokens:reset        — wipe everything
//
// Plus a push channel:
//   tokens:update       — emitted on every ledger change. Carries the
//                         full snapshot so consumers can render without
//                         a follow-up round-trip.

/**
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('../../src/core/tokenLedger').TokenLedger} deps.tokenLedger
 * @param {(event: string, payload: any) => void} deps.broadcast
 */
function register({ ipcMain, tokenLedger, broadcast }) {
  ipcMain.handle('tokens:snapshot', () => ({
    ok: true, snapshot: tokenLedger.snapshot(),
  }));
  ipcMain.handle('tokens:by-worker', (_e, { id } = {}) => ({
    ok: true, totals: tokenLedger.byWorker(id),
  }));
  ipcMain.handle('tokens:reset', () => {
    tokenLedger.reset();
    return { ok: true };
  });
  // Push updates to every renderer on every change. The chip and the
  // future analytics panel both subscribe to this. Subscribers can
  // throttle on the renderer side if needed; the ledger only fires
  // when record/forget/reset actually changes something.
  tokenLedger.subscribe((snapshot) => {
    try { broadcast('tokens:update', { snapshot }); }
    catch { /* never crash the app on a renderer-push failure */ }
  });
}

module.exports = { register };
