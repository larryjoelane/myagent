// Background-process registry — module-level singleton that owns
// long-running child processes spawned by `bash` with run_in_background.
//
// Lifecycle:
//   register(child, { command, cwd })   -> pid
//   getEntry(pid)                       -> { pid, command, cwd, status,
//                                            startedAt, exitedAt, exitCode,
//                                            signal }
//   readSince(pid, cursor)              -> { stdout, stderr, nextCursor,
//                                            stdoutTruncated, stderrTruncated }
//   kill(pid, signal)                   -> boolean (true if a live child
//                                            received the signal)
//   list()                              -> entry[] (running first, then
//                                            recent exits)
//   remove(pid)                         -> remove from the table
//
// Ring buffers cap total captured bytes per stream so a chatty process
// can't fill memory. The read cursor is a monotonic counter against the
// TOTAL bytes written to the stream (not the ring's current contents),
// so the model's next read is always a strict continuation even if a
// chunk slid off the back. When bytes are dropped we set
// stdoutTruncated/stderrTruncated on the next read so the caller knows
// there's a gap.
//
// Process cleanup: a single process.on('exit') hook SIGKILLs everything
// still running so we don't leak children when Electron quits cleanly.
// Hard crashes still leak — accepted trade-off for v1.

const DEFAULT_BUFFER_BYTES = 256 * 1024;
const MAX_RECENT_EXITED = 32;

class RingBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.chunks = [];      // { offset, buf } — offset is the absolute byte index of buf[0]
    this.totalWritten = 0; // monotonic count of all bytes ever appended
    this.heldBytes = 0;    // sum of buf.length across chunks
  }

  append(buf) {
    if (!buf || buf.length === 0) return;
    this.chunks.push({ offset: this.totalWritten, buf });
    this.totalWritten += buf.length;
    this.heldBytes += buf.length;
    while (this.heldBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overflow = this.heldBytes - this.maxBytes;
      if (head.buf.length <= overflow) {
        this.chunks.shift();
        this.heldBytes -= head.buf.length;
      } else {
        head.buf = head.buf.slice(overflow);
        head.offset += overflow;
        this.heldBytes -= overflow;
      }
    }
  }

  // Read bytes from absolute offset `since` onward. Returns
  // { text, nextCursor, truncated } where truncated indicates that some
  // bytes between `since` and the earliest available byte were dropped.
  readSince(since) {
    const cursor = Math.max(0, since | 0);
    const earliest = this.chunks.length ? this.chunks[0].offset : this.totalWritten;
    const startFrom = Math.max(cursor, earliest);
    const truncated = cursor < earliest;
    if (startFrom >= this.totalWritten) {
      return { text: '', nextCursor: this.totalWritten, truncated };
    }
    const out = [];
    for (const c of this.chunks) {
      const cEnd = c.offset + c.buf.length;
      if (cEnd <= startFrom) continue;
      if (c.offset >= startFrom) {
        out.push(c.buf);
      } else {
        out.push(c.buf.slice(startFrom - c.offset));
      }
    }
    return {
      text: Buffer.concat(out).toString('utf8'),
      nextCursor: this.totalWritten,
      truncated,
    };
  }
}

class Registry {
  constructor() {
    /** @type {Map<number, object>} */
    this.entries = new Map();
    this.exitedOrder = []; // pids of exited entries, oldest first, for trim
    this._installCleanup();
  }

  register(child, { command, cwd, bufferBytes = DEFAULT_BUFFER_BYTES } = {}) {
    if (!child || typeof child.pid !== 'number') {
      throw new Error('processes.register: child with .pid required');
    }
    const pid = child.pid;
    const entry = {
      pid,
      command,
      cwd,
      child,
      status: 'running',
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      signal: null,
      stdout: new RingBuffer(bufferBytes),
      stderr: new RingBuffer(bufferBytes),
    };
    this.entries.set(pid, entry);

    child.stdout && child.stdout.on('data', (chunk) => entry.stdout.append(chunk));
    child.stderr && child.stderr.on('data', (chunk) => entry.stderr.append(chunk));
    child.on('close', (code, signal) => {
      entry.status = 'exited';
      entry.exitedAt = Date.now();
      entry.exitCode = typeof code === 'number' ? code : null;
      entry.signal = signal || null;
      this.exitedOrder.push(pid);
      this._trimExited();
    });
    child.on('error', (err) => {
      if (entry.status === 'running') {
        entry.status = 'exited';
        entry.exitedAt = Date.now();
        entry.exitCode = null;
        entry.signal = null;
        entry.error = err.message;
        this.exitedOrder.push(pid);
        this._trimExited();
      }
    });
    return pid;
  }

  getEntry(pid) {
    return this.entries.get(pid) || null;
  }

  readSince(pid, cursor = 0) {
    const entry = this.entries.get(pid);
    if (!entry) return null;
    const o = entry.stdout.readSince(cursor.stdout || 0);
    const e = entry.stderr.readSince(cursor.stderr || 0);
    return {
      stdout: o.text,
      stderr: e.text,
      nextCursor: { stdout: o.nextCursor, stderr: e.nextCursor },
      stdoutTruncated: o.truncated,
      stderrTruncated: e.truncated,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
    };
  }

  kill(pid, signal = 'SIGTERM') {
    const entry = this.entries.get(pid);
    if (!entry) return false;
    if (entry.status !== 'running') return false;
    try {
      entry.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  remove(pid) {
    const entry = this.entries.get(pid);
    if (!entry) return false;
    if (entry.status === 'running') {
      try { entry.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.entries.delete(pid);
    const idx = this.exitedOrder.indexOf(pid);
    if (idx >= 0) this.exitedOrder.splice(idx, 1);
    return true;
  }

  list() {
    const running = [];
    const exited = [];
    for (const e of this.entries.values()) {
      const view = {
        pid: e.pid,
        command: e.command,
        cwd: e.cwd,
        status: e.status,
        startedAt: e.startedAt,
        exitedAt: e.exitedAt,
        exitCode: e.exitCode,
        signal: e.signal,
        uptimeMs: (e.exitedAt || Date.now()) - e.startedAt,
      };
      if (e.status === 'running') running.push(view);
      else exited.push(view);
    }
    return [...running, ...exited];
  }

  _trimExited() {
    while (this.exitedOrder.length > MAX_RECENT_EXITED) {
      const oldest = this.exitedOrder.shift();
      this.entries.delete(oldest);
    }
  }

  _installCleanup() {
    if (Registry._cleanupInstalled) return;
    Registry._cleanupInstalled = true;
    const killAll = () => {
      for (const e of this.entries.values()) {
        if (e.status !== 'running') continue;
        try { e.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };
    process.on('exit', killAll);
  }
}

const singleton = new Registry();

module.exports = singleton;
module.exports.Registry = Registry; // exposed for tests
module.exports.RingBuffer = RingBuffer;
module.exports.DEFAULT_BUFFER_BYTES = DEFAULT_BUFFER_BYTES;
