#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const cli = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
const args = ['list', ...process.argv.slice(2)];
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
