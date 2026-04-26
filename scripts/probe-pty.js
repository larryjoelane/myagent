// One-off probe: verify @lydell/node-pty loads in Electron's ABI.
// Run: node_modules/.bin/electron scripts/probe-pty.js
const { app } = require('electron');
app.whenReady().then(() => {
  try {
    const pty = require('@lydell/node-pty');
    console.log('LOADED:', Object.keys(pty).join(','));
  } catch (e) {
    console.error('LOAD FAIL:', e.message);
    process.exitCode = 1;
  }
  app.quit();
});
