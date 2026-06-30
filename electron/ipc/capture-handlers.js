// IPC handlers for the in-app dev screenshot button:
//   capture:is-dev      — true only in a dev/from-source run (drives the
//                         topbar camera button's visibility)
//   capture:screenshot  — grab the requesting window's current frame and
//                         write it to docs/screenshots/ as a PNG. DEV-ONLY:
//                         a no-op (returns { ok:false, reason:'not-dev' }) in
//                         a packaged build, so the capability can never ship
//                         to end users.
//
// Capture is webContents.capturePage() (the live composited frame), not a
// renderer-side canvas — so it includes everything the user sees in the
// window: chat bubbles, the editor, drawers, popups.

const path = require('path');
const fs = require('fs');

/** Two-digit zero-pad for the timestamped filename. */
function pad(n) { return String(n).padStart(2, '0'); }

/** Filesystem-safe timestamp like 2026-06-29_14-07-32. */
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Keep a user-supplied label to a safe single filename segment. */
function safeLabel(label) {
  if (!label || typeof label !== 'string') return '';
  const cleaned = label.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned ? `-${cleaned.slice(0, 40)}` : '';
}

/**
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').BrowserWindow} deps.BrowserWindow
 * @param {string} deps.projectRoot - repo root; screenshots land under it
 * @param {boolean} deps.isDev - true for dev/from-source runs only
 */
function register({ ipcMain, BrowserWindow, projectRoot, isDev }) {
  const outDir = path.join(projectRoot, 'docs', 'screenshots');

  ipcMain.handle('capture:is-dev', () => ({ ok: true, isDev: !!isDev }));

  ipcMain.handle('capture:screenshot', async (event, body = {}) => {
    // Hard gate: never capture in a packaged build, even if a renderer
    // somehow invokes the channel.
    if (!isDev) return { ok: false, reason: 'not-dev', error: 'screenshot capture is dev-only' };

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { ok: false, reason: 'no-window', error: 'no window to capture' };
    }
    try {
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) {
        return { ok: false, reason: 'empty', error: 'captured an empty frame' };
      }
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `shot-${stamp()}${safeLabel(body.label)}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, reason: 'io', error: err.message };
    }
  });
}

module.exports = { register, stamp, safeLabel };
