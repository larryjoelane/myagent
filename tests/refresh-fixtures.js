#!/usr/bin/env node
// Regenerate the captured stream-json fixtures used by
// tests/claudeDriver.test.js. Run when:
//   - claude version updates and the schema changes
//   - we add new fixture-driven tests
//
// Usage:
//   node tests/refresh-fixtures.js
//
// Costs a few cents per run. Overwrites tests/fixtures/claude-events/.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.resolve(__dirname, 'fixtures', 'claude-events');
fs.mkdirSync(DIR, { recursive: true });

// Each fixture is a (file, args, prompt) tuple. We invoke claude in
// non-interactive mode and capture stdout.
const FIXTURES = [
  {
    file: '01-simple.jsonl',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'],
    prompt: 'say hello in five words',
  },
  {
    file: '02-tool-call.jsonl',
    args: ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-mode', 'bypassPermissions'],
    prompt: 'list the files in the current directory using bash, then count them',
  },
  {
    file: '04-permission.jsonl',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'],
    prompt: "run 'echo hello' in bash",
  },
  {
    file: '05-write-permission.jsonl',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'],
    prompt: 'create a file called /tmp/permission-test.txt with the word hello in it',
  },
];

async function captureOne(spec) {
  return new Promise((resolve, reject) => {
    const out = path.join(DIR, spec.file);
    const child = spawn('claude', [...spec.args, spec.prompt], { shell: true });
    const chunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('exit', (code) => {
      if (code !== 0) {
        const err = Buffer.concat(stderrChunks).toString();
        reject(new Error(`claude exited ${code} for ${spec.file}: ${err}`));
        return;
      }
      fs.writeFileSync(out, Buffer.concat(chunks));
      const lines = Buffer.concat(chunks).toString().split('\n').filter(Boolean).length;
      console.log(`  wrote ${spec.file} (${lines} lines)`);
      resolve();
    });
    child.on('error', reject);
  });
}

(async () => {
  console.log(`Refreshing ${FIXTURES.length} fixtures into ${DIR}`);
  for (const spec of FIXTURES) {
    process.stdout.write(`  ${spec.file}…\n`);
    try { await captureOne(spec); }
    catch (err) {
      process.stderr.write(`  failed: ${err.message}\n`);
      process.exit(1);
    }
  }
  console.log('Done. Run `npm test` to verify the new fixtures still satisfy assertions.');
})();
