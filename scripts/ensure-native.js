#!/usr/bin/env node
// Idempotent native-module rebuilder. Decides whether better-sqlite3
// needs to be rebuilt for the requested target ABI (`node` or `electron`)
// and runs the right command only when it does.
//
// Why this exists:
//   better-sqlite3 ships a single .node file at build/Release/. The file
//   is ABI-specific — a binary built for Electron's V8 won't load in
//   plain Node, and vice versa. We track which ABI the current binary
//   was built for in build/Release/.abi-stamp so subsequent installs /
//   launches can short-circuit when the binary already matches.
//
// Usage:
//   node scripts/ensure-native.js electron     # rebuild for Electron if needed
//   node scripts/ensure-native.js node         # rebuild for Node if needed
//   node scripts/ensure-native.js auto         # pick from EXEC_TARGET env or default electron
//
// Exits 0 on success or no-op, non-zero on failure. Output is informational
// only — npm scripts capture stdout, so keep it concise.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3');
const BINARY = path.join(MODULE_DIR, 'build', 'Release', 'better_sqlite3.node');
const STAMP = path.join(MODULE_DIR, 'build', 'Release', '.abi-stamp');

// Read the Electron version from devDependencies so the stamp can change
// when the user bumps Electron — bumping V8 means the existing binary is
// stale even if it was previously built for Electron.
function electronVersion() {
  try {
    const pkg = require(path.join(PROJECT_ROOT, 'node_modules', 'electron', 'package.json'));
    return pkg.version;
  } catch { return 'unknown'; }
}

function nodeAbi() {
  // process.versions.modules is the NODE_MODULE_VERSION (ABI) string —
  // unique per Node major. Used by better-sqlite3 at load time to decide
  // whether the .node file matches.
  return `node-${process.versions.modules}`;
}

function expectedStamp(target) {
  if (target === 'electron') return `electron-${electronVersion()}`;
  if (target === 'node') return nodeAbi();
  throw new Error(`unknown target: ${target}`);
}

function readStamp() {
  try { return fs.readFileSync(STAMP, 'utf8').trim(); } catch { return null; }
}

function writeStamp(value) {
  try { fs.writeFileSync(STAMP, value, 'utf8'); } catch { /* ignore */ }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

function rebuildElectron() {
  process.stdout.write(`ensure-native: rebuilding better-sqlite3 for Electron ${electronVersion()}\n`);
  return run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3']);
}

function rebuildNode() {
  process.stdout.write(`ensure-native: rebuilding better-sqlite3 for Node ${process.version}\n`);
  return run('npm', ['rebuild', 'better-sqlite3']);
}

function ensure(target) {
  if (!fs.existsSync(MODULE_DIR)) {
    // Module not installed yet — nothing to do. This happens during the
    // npm-install phase before postinstall fires, but we're defensive.
    process.stdout.write('ensure-native: better-sqlite3 not installed; skipping\n');
    return true;
  }

  const want = expectedStamp(target);
  const have = readStamp();
  if (have === want && fs.existsSync(BINARY)) {
    process.stdout.write(`ensure-native: ${target} ABI up to date (${want})\n`);
    return true;
  }

  const ok = target === 'electron' ? rebuildElectron() : rebuildNode();
  if (!ok) {
    process.stderr.write(`ensure-native: rebuild failed for ${target}\n`);
    return false;
  }
  writeStamp(want);
  return true;
}

function pickTarget(arg) {
  if (arg === 'electron' || arg === 'node') return arg;
  if (arg === 'auto' || !arg) return process.env.EXEC_TARGET === 'node' ? 'node' : 'electron';
  process.stderr.write(`ensure-native: unknown target "${arg}"\n`);
  process.exit(2);
}

const ok = ensure(pickTarget(process.argv[2]));
process.exit(ok ? 0 : 1);
