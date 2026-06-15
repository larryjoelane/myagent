// Fake child_process for ClaudeDriver tests. Returns an object with
// the same shape ClaudeDriver consumes: stdout/stderr (Readable),
// stdin (Writable), 'exit' and 'error' events.
//
// Two helpers:
//   makeFake() — returns { proc, controls } where controls lets the
//                test feed lines, exit, etc.
//   replayFixture(file, opts) — returns a spawnFn that, when called,
//                emits each line from the fixture file with optional
//                delay.

const { Readable, Writable } = require('stream');
const { EventEmitter } = require('events');
const fs = require('fs');

function makeFake() {
  const proc = new EventEmitter();
  // stdin: collect writes, expose for assertions.
  const writes = [];
  proc.stdin = new Writable({
    write(chunk, enc, cb) {
      writes.push(chunk.toString('utf8'));
      cb();
    },
    final(cb) { cb(); },
  });
  proc.stdin.writes = writes;

  // stdout/stderr: Readables we push lines into.
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  // ClaudeDriver calls setEncoding('utf8'); Readables support it natively.

  let exited = false;
  const controls = {
    pushStdout(text) {
      if (exited) return;
      proc.stdout.push(text);
    },
    pushLine(obj) {
      if (typeof obj === 'string') controls.pushStdout(obj + '\n');
      else controls.pushStdout(JSON.stringify(obj) + '\n');
    },
    exit(code = 0, signal = null) {
      if (exited) return;
      exited = true;
      proc.stdout.push(null);
      proc.stderr.push(null);
      // Defer so any in-flight stdout-data handlers fire first.
      setImmediate(() => proc.emit('exit', code, signal));
    },
    fireError(err) {
      proc.emit('error', err);
    },
    writes,
  };
  return { proc, controls };
}

// Replay a JSONL fixture as a fake spawn. Each line is pushed onto
// stdout in order with `delayMs` between them; afterwards the process
// exits cleanly.
function replayFixture(file, { delayMs = 5, exitCode = 0 } = {}) {
  return () => {
    const { proc, controls } = makeFake();
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    (async () => {
      // Wait for the test to write at least one line on stdin before
      // we start emitting — claude only emits AFTER receiving a user
      // message. The driver always writes immediately on send().
      await new Promise((resolve) => {
        if (controls.writes.length > 0) return resolve();
        const onWrite = () => { proc.stdin.removeListener('finish', onWrite); resolve(); };
        // Instead of listeners, poll briefly.
        const t = setInterval(() => {
          if (controls.writes.length > 0) { clearInterval(t); resolve(); }
        }, 5);
        // Safety timeout.
        setTimeout(() => { clearInterval(t); resolve(); }, 2000);
      });
      for (const line of lines) {
        controls.pushLine(line);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      controls.exit(exitCode);
    })();
    return proc;
  };
}

module.exports = { makeFake, replayFixture };
