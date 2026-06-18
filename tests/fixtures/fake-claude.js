#!/usr/bin/env node
// Fake claude for end-to-end tests. Mimics claude's interactive TUI
// well enough to exercise the same code path in our channel pipeline:
// status bar with spinner glyph, response text, hint bar, prompt bar
// with ❯, separators.
//
// Behavior:
//   - On launch, paint the idle screen (no status bar, prompt visible).
//   - Read lines from stdin. For each line:
//       1. Show the status bar with a spinner.
//       2. Wait ~200ms.
//       3. Print a hardcoded response that includes the prompt text.
//       4. Drop the status bar (turn ends).
//   - Exit on EOF or "exit".
//
// We intentionally use the SAME ANSI shapes our profile recognizes —
// this fake validates the integration, not the profile itself.

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Read the actual PTY size from process.stdout — node-pty pipes resize
// events through to the child via SIGWINCH and updates these
// properties. Fallback to env vars if stdout isn't a TTY (testing the
// script directly).
function cols() { return process.stdout.columns || parseInt(process.env.FAKE_CLAUDE_COLS || '100', 10); }
function rows() { return process.stdout.rows || parseInt(process.env.FAKE_CLAUDE_ROWS || '24', 10); }
function sep() { return '─'.repeat(Math.max(20, cols() - 4)); }

function write(s) { process.stdout.write(s); }
function clear() { write('\x1b[2J\x1b[H'); }
function moveTo(row, col) { write(`\x1b[${row};${col}H`); }
function eraseLine() { write('\x1b[2K'); }

let spinnerIdx = 0;
let spinnerTimer = null;
let busy = false;

function startSpinner(label) {
  if (spinnerTimer) return;
  busy = true;
  spinnerTimer = setInterval(() => {
    moveTo(1, 1); eraseLine();
    write(`${SPINNER[spinnerIdx % SPINNER.length]} ${label} 0.${spinnerIdx % 10}k tokens`);
    spinnerIdx += 1;
  }, 80);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  moveTo(1, 1); eraseLine();
  busy = false;
}

function paintIdleFrame() {
  clear();
  const r = rows();
  moveTo(r - 4, 1); write(sep() + '\r\n');
  moveTo(r - 3, 1); write('❯ ');
  moveTo(r - 2, 1); write(sep() + '\r\n');
  moveTo(r - 1, 1); write('  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt');
}

async function handleLine(line) {
  if (!line.trim()) { paintIdleFrame(); return; }
  if (line.trim() === 'exit') { process.exit(0); }

  startSpinner('Sublimating…');
  await sleep(parseInt(process.env.FAKE_CLAUDE_LATENCY_MS || '300', 10));

  // Print the response above the prompt area.
  moveTo(3, 1); write(`Response to: ${line.trim()}\r\n`);
  // Sometimes simulate a tool block.
  if (line.includes('tool')) {
    write('\r\n');
    write('● Bash\r\n');
    write('  ls -la\r\n');
    write('  ⎿  total 42\r\n');
    write('       drwxr-xr-x ...\r\n');
    write('\r\n');
    write('That is the directory contents.\r\n');
  }

  await sleep(150);
  stopSpinner();
  // Repaint prompt area to show "ready" again.
  moveTo(rows() - 3, 1); write('❯ ');
}

// Bound the delay so an env-provided latency (FAKE_CLAUDE_LATENCY_MS) can't
// create an unbounded timer that wedges the test (js/resource-exhaustion).
// Match CodeQL's recognized shape: reject out-of-range values (early return)
// rather than reassign, so a value exceeding the cap never reaches setTimeout.
const MAX_SLEEP_MS = 30_000;
function sleep(ms) {
  const d = Number(ms);
  if (!Number.isFinite(d) || d < 0 || d > MAX_SLEEP_MS) {
    // Out of the accepted range — use the safe default instead of the input.
    return new Promise((r) => setTimeout(r, 0));
  }
  return new Promise((r) => setTimeout(r, d));
}

async function main() {
  // Hide cursor to look more app-y.
  write('\x1b[?25l');
  process.on('exit', () => write('\x1b[?25h\x1b[2J\x1b[H'));

  paintIdleFrame();

  // Line-buffered stdin.
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.search(/\r\n|\r|\n/)) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
      // Don't queue concurrent turns — wait for current to finish.
      while (busy) await sleep(20);
      await handleLine(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(`fake-claude: ${err.stack || err}\n`);
  process.exit(1);
});
