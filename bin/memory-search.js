#!/usr/bin/env node
// memory-search CLI entry point.
//
// Re-execs the implementation (bin/memory-search-impl.js) under
// Electron's bundled Node via ELECTRON_RUN_AS_NODE=1. That way the
// CLI uses the SAME native-module ABI as the running Electron app —
// `better-sqlite3` only needs one rebuild (`npm run rebuild:electron`)
// and both the app and this CLI work. No more ping-pong between
// `rebuild:node` and `rebuild:electron`.
//
// Detection: when ELECTRON_RUN_AS_NODE is already set we ARE the
// re-exec'd child, so just hand off to the impl in-process. Otherwise
// spawn the child and forward exit code + stdio.

const path = require('path');
const child_process = require('child_process');

// Heuristic for "are we running under Electron as Node?" The env var
// is the contract Electron itself uses, and `process.versions.electron`
// is set inside the Electron Node runtime. Either is sufficient.
const RUNNING_UNDER_ELECTRON =
  process.env.ELECTRON_RUN_AS_NODE === '1' ||
  Boolean(process.versions.electron);

if (RUNNING_UNDER_ELECTRON) {
  // Same process: just delegate. The impl uses its own try/catch and
  // exit codes, so no extra wrapping needed.
  require('./memory-search-impl');
} else {
  // Re-exec under Electron. `require('electron')` resolves to the
  // electron binary path when called from a regular Node process —
  // this is the documented mechanism, not a hack.
  let electronBin;
  try {
    electronBin = require('electron');
  } catch (err) {
    process.stderr.write(
      `memory-search: cannot find Electron — run \`npm install\` in the project root.\n` +
      `  underlying error: ${err.message}\n`,
    );
    process.exit(1);
  }
  const impl = path.join(__dirname, 'memory-search-impl.js');
  const child = child_process.spawnSync(electronBin, [impl, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (child.error) {
    process.stderr.write(`memory-search: failed to launch Electron — ${child.error.message}\n`);
    process.exit(1);
  }
  process.exit(child.status == null ? 1 : child.status);
}
