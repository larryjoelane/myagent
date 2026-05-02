#!/usr/bin/env node
// Skill helper: search memory. Thin wrapper that locates the package's
// CLI relative to this script so the skill works without a global install.

const path = require('path');
const { spawn } = require('child_process');

const cli = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
const args = ['search', ...process.argv.slice(2)];
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
