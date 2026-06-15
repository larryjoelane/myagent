// Probe: drive claude in long-running stream-json mode.
// Spawns claude once, sends two prompts, prints all output events,
// then closes stdin so claude exits.

const { spawn } = require('child_process');
const fs = require('fs');

const child = spawn('claude', [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true, // claude.cmd on Windows
});

const out = fs.createWriteStream('tests/fixtures/claude-events/03-streaming.jsonl');

let buffer = '';
let lineCount = 0;
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    lineCount++;
    out.write(line + '\n');
    try {
      const e = JSON.parse(line);
      console.log(`[${lineCount}] ${e.type}${e.subtype ? '/' + e.subtype : ''}${e.event ? '#' + e.event.type : ''}`);
    } catch {
      console.log(`[${lineCount}] (non-JSON) ${line.slice(0, 80)}`);
    }
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(`[stderr] ${chunk}`);
});

child.on('exit', (code) => {
  console.log(`\nclaude exited with code ${code}, total events: ${lineCount}`);
  out.end();
});

// Helper: send a user message in the stream-json input format.
function sendUserMessage(text) {
  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
  child.stdin.write(JSON.stringify(msg) + '\n');
  console.log(`SENT: ${text}`);
}

(async () => {
  await new Promise(r => setTimeout(r, 800)); // let claude initialize
  sendUserMessage('say hello in three words');
  // Wait for the result event before sending the next.
  await new Promise(r => setTimeout(r, 8000));
  sendUserMessage('now say goodbye in three words');
  await new Promise(r => setTimeout(r, 8000));
  child.stdin.end();
})();
