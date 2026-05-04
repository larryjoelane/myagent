// Helper for `npm run dev`: waits for Vite's dev server to be reachable,
// then spawns Electron with VITE_DEV_SERVER_URL set so main.js loads the
// renderer over HTTP instead of from disk.
//
// Why this script and not just `concurrently vite electron .`?
//   - Electron starts in ~200ms; Vite takes 1–2s to bind the port. If
//     Electron loads first, the renderer fetch fails and the window
//     paints blank.
//   - We need to set VITE_DEV_SERVER_URL on the Electron child only —
//     so main.js can detect dev mode without reaching for app.isPackaged
//     or NODE_ENV.

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const HOST = 'localhost';
const PORT = 5173;
const URL = `http://${HOST}:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

function ping() {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

async function waitForVite() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`vite dev server did not become ready on ${URL} within ${READY_TIMEOUT_MS}ms`);
}

async function main() {
  await waitForVite();
  // Resolve electron from node_modules — works on Windows and POSIX.
  const electronBin = require('electron');
  const child = spawn(electronBin, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: URL },
    // shell: false; spawning the resolved binary path directly.
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  // Forward Ctrl+C so the renderer side of `concurrently` can clean up.
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[dev-electron] ${err.message}`);
  process.exit(1);
});
