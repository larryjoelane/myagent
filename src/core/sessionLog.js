// Per-launch session logger. Writes NDJSON to
// .myagent/sessions/session-<timestamp>.ndjson — one JSON object per line:
//
//   { ts, pane, kind, text }
//
// Kinds in use today:
//   agent-in    user prompt submitted to the agent
//   agent-out   streamed assistant text (post-think-strip, what the user sees)
//   tool-start  { name, arguments }
//   tool-end    { name, result?, error? }
//   agent-done  { truncated, reason? }
//   agent-error { message }
//   pty-start   { paneId, shell, pid, cwd, rawLog? }
//   pty-in      raw bytes the user sent to the PTY (ANSI-stripped in NDJSON)
//   pty-out     bytes the PTY sent to the renderer (ANSI-stripped in NDJSON)
//   pty-exit    { exitCode, signal }
//   pty-agent-summary
//               Per-`claude`-invocation summary correlated from Claude Code's
//               own JSONL: { sessionId, model, permissionMode, version,
//               gitBranch, cwd, firstTimestamp, lastTimestamp, userTurns,
//               assistantTurns, toolUses, usage:{inputTokens, outputTokens,
//               cacheCreationInputTokens, cacheReadInputTokens}, file }.
//               Emitted on pty-exit for any sessions that ran in the window.
//
// ANSI handling:
//   PTY output is full of VT escape sequences (color, cursor moves, mode
//   switches). The NDJSON `text` strips those so a human reading the log
//   isn't wading through control codes — but \n, \r, and \t are preserved,
//   and the explicit `pty-exit` event marks end-of-session for each PTY.
//
//   For faithful replay (TUIs like `claude` that use the alt screen and
//   cursor positioning), each pane also gets a raw byte log written to
//   pty-<pane>-<timestamp>.raw alongside the NDJSON. These contain the
//   exact bytes from the child PTY and can be replayed with `cat` on a
//   real terminal. The path is recorded in the `pty-start` entry's
//   `rawLog` field. Input bytes are not raw-logged — keystrokes rarely
//   need replay and would interleave confusingly with output timing.

const fs = require('fs');
const path = require('path');
const { safeComponent } = require('./safePath');

class SessionLog {
  constructor({ dir }) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.stamp = stamp;
    // js/path-injection barrier (inlined): resolve the log file under this.dir
    // and require containment before opening the stream.
    this.path = path.resolve(this.dir, `session-${stamp}.ndjson`);
    if (!this.path.startsWith(this.dir + path.sep)) {
      throw new Error('SessionLog: log path escapes dir');
    }
    // Append mode so a crash mid-write keeps prior entries on disk.
    this.stream = fs.createWriteStream(this.path, { flags: 'a' });
    // Swallow stream errors — late writes during shutdown can otherwise
    // bubble up as "write after end" unhandled errors. Logging must
    // never crash the app.
    this.stream.on('error', () => { /* ignore */ });
    this.closed = false;
    // Raw PTY byte streams, one per pane. Lazily created on first openRaw().
    this.rawStreams = new Map();
    this.append('session-start', { pid: process.pid, cwd: process.cwd() });
  }

  // Open (or reopen) a raw byte log for a pane. Returns the absolute path so
  // the caller can record it in the pty-start NDJSON entry. If a stream is
  // already open for this pane (e.g. a previous shell exited and a new one
  // started), it's closed first so each PTY session gets its own file.
  openRaw(paneId) {
    // Pane id becomes part of the filename — validate it as a single safe
    // component so a crafted id can't traverse out of this.dir.
    const pane = safeComponent(paneId || 'main');
    const existing = this.rawStreams.get(pane);
    if (existing) {
      try { existing.end(); } catch { /* ignore */ }
      this.rawStreams.delete(pane);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // js/path-injection barrier (inlined): pane is a safe component; resolve
    // under this.dir and require containment before opening the stream.
    const file = path.resolve(this.dir, `pty-${pane}-${stamp}.raw`);
    if (!file.startsWith(this.dir + path.sep)) {
      throw new Error('SessionLog: raw path escapes dir');
    }
    const stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { /* ignore late writes during shutdown */ });
    this.rawStreams.set(pane, stream);
    return file;
  }

  rawOut(paneId, raw) {
    if (!raw) return;
    const stream = this.rawStreams.get(paneId || 'main');
    if (!stream || stream.writableEnded) return;
    try {
      stream.write(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw);
    } catch { /* logging must never crash the app */ }
  }

  closeRaw(paneId) {
    const pane = paneId || 'main';
    const stream = this.rawStreams.get(pane);
    if (!stream) return;
    try { stream.end(); } catch { /* ignore */ }
    this.rawStreams.delete(pane);
  }

  append(kind, fields = {}, pane = null) {
    // Drop silently if close() already ran. Without this guard, late
    // events during app shutdown (PTY exits firing after `before-quit`
    // calls close()) write to an ended stream and surface as
    // "write after end" errors.
    if (this.closed || this.stream.writableEnded) return;
    const entry = {
      ts: new Date().toISOString(),
      pane,
      kind,
      ...fields,
    };
    try {
      this.stream.write(JSON.stringify(entry) + '\n');
    } catch {
      // Logging must never crash the app. Drop on failure.
    }
  }

  text(kind, text, pane = null) {
    if (text == null || text === '') return;
    this.append(kind, { text }, pane);
  }

  ptyOut(paneId, raw) {
    if (!raw) return;
    this.append('pty-out', { text: stripAnsi(String(raw)) }, paneId);
  }

  ptyIn(paneId, raw) {
    if (!raw) return;
    // PTY input is what the user typed; usually plain but may contain
    // control bytes (Ctrl-C = 0x03, etc.). Strip the visual-only escape
    // sequences but keep control bytes — they're meaningful as input.
    this.append('pty-in', { text: stripAnsi(String(raw)) }, paneId);
  }

  close() {
    if (this.closed) return;
    this.append('session-end', {});
    this.closed = true;
    try { this.stream.end(); } catch { /* ignore */ }
    for (const [, s] of this.rawStreams) {
      try { s.end(); } catch { /* ignore */ }
    }
    this.rawStreams.clear();
  }
}

// Strip ANSI / VT escape sequences while preserving:
//   \n (line feed), \r (carriage return), \t (tab), and any other
//   printable / non-escape control bytes (e.g. Ctrl-C).
//
// Covered:
//   CSI:  ESC [ ... <final byte 0x40-0x7E>      colors, cursor moves
//   OSC:  ESC ] ... (BEL | ESC \)               window titles
//   Single-char ESC sequences: ESC <0x40-0x5F>  charset / reset
//   Two-byte CSI introducer (ESC c, ESC =, etc.) plus their params
function stripAnsi(s) {
  if (!s) return s;
  return s
    // OSC: ESC ] ... BEL  or  ESC ] ... ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ params final-byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // ESC followed by a single intermediate / final byte (charset, RIS, etc.)
    .replace(/\x1b[@-Z\\-_]/g, '');
}

module.exports = { SessionLog, stripAnsi };
