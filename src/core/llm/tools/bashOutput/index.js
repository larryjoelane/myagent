// bash_output — read incremental stdout/stderr from a process started by
// `bash` with run_in_background.
//
// Args:
//   { pid: number, cursor?: { stdout: number, stderr: number } }
//
// Behavior:
//   - With no cursor: returns everything currently in the ring buffer.
//   - With a cursor: returns only what arrived since that cursor. The
//     response's `next_cursor` is what to pass on the next call.
//   - If bytes between the cursor and the earliest buffered byte were
//     dropped (very chatty process), stdout_truncated / stderr_truncated
//     mark the gap so the model knows it lost some output.
//   - Includes status: "running" | "exited" plus exit_code/signal once
//     the process has finished.

const processes = require('../bash/processes');

module.exports = {
  name: 'bash_output',
  description:
    'Read incremental stdout/stderr from a background bash process. ' +
    'Pass the pid returned by `bash` with run_in_background. Reuse the ' +
    'next_cursor from the previous call to get only new output. Use to ' +
    'watch a dev server\'s logs or wait for a build to finish.',
  parameters: {
    type: 'object',
    properties: {
      pid: {
        type: 'integer',
        description: 'Process id returned by bash run_in_background.',
      },
      cursor: {
        type: 'object',
        description: 'Opaque cursor returned as next_cursor on the previous call. Omit on the first call to read everything in the buffer.',
        properties: {
          stdout: { type: 'integer', minimum: 0 },
          stderr: { type: 'integer', minimum: 0 },
        },
      },
    },
    required: ['pid'],
  },
  async run(args) {
    const pid = Number.parseInt(args.pid, 10);
    if (!Number.isFinite(pid)) {
      return { ok: false, content: 'bash_output: missing required integer argument "pid"' };
    }
    const cursor = args.cursor && typeof args.cursor === 'object'
      ? { stdout: Number(args.cursor.stdout) || 0, stderr: Number(args.cursor.stderr) || 0 }
      : { stdout: 0, stderr: 0 };

    const read = processes.readSince(pid, cursor);
    if (!read) {
      return { ok: false, content: `bash_output: no process with pid ${pid} (it may have been removed)` };
    }

    const lines = [];
    lines.push(`pid=${pid} status=${read.status}${read.status === 'exited' ? ` exit=${read.exitCode == null ? '?' : read.exitCode}${read.signal ? ` signal=${read.signal}` : ''}` : ''}`);
    if (read.stdout) {
      lines.push('--- stdout ---');
      lines.push(read.stdout.replace(/\s+$/, ''));
      if (read.stdoutTruncated) lines.push('[stdout: earlier bytes dropped from ring buffer]');
    }
    if (read.stderr) {
      lines.push('--- stderr ---');
      lines.push(read.stderr.replace(/\s+$/, ''));
      if (read.stderrTruncated) lines.push('[stderr: earlier bytes dropped from ring buffer]');
    }
    if (!read.stdout && !read.stderr) lines.push('(no new output)');

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        pid,
        status: read.status,
        exit_code: read.exitCode,
        signal: read.signal,
        stdout: read.stdout,
        stderr: read.stderr,
        next_cursor: read.nextCursor,
        stdout_truncated: read.stdoutTruncated,
        stderr_truncated: read.stderrTruncated,
      },
    };
  },
};
