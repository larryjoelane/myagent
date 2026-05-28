// bash_kill — stop a background bash process started by run_in_background.
//
// Args:
//   { pid: number, signal?: 'SIGTERM' | 'SIGKILL' }
//
// Default signal is SIGTERM (graceful). Use SIGKILL when the process
// won't respond. On Windows, both signals end up forcing termination;
// the distinction matters more on POSIX where SIGTERM is a request and
// the process may handle it.
//
// The process entry stays in the registry after kill so bash_output can
// still return final logs. Drop it explicitly by passing remove=true.

const processes = require('../bash/processes');

const ALLOWED_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'];

module.exports = {
  name: 'bash_kill',
  description:
    'Stop a background bash process by pid. Defaults to SIGTERM; pass ' +
    'signal=SIGKILL for stubborn processes. The entry stays in the ' +
    'registry so you can still call bash_output to read final logs.',
  parameters: {
    type: 'object',
    properties: {
      pid: {
        type: 'integer',
        description: 'Process id returned by bash run_in_background.',
      },
      signal: {
        type: 'string',
        enum: ALLOWED_SIGNALS,
        description: 'Signal to send. Default SIGTERM.',
      },
      remove: {
        type: 'boolean',
        description: 'Also remove the entry from the registry so its pid is no longer tracked. Default false.',
      },
    },
    required: ['pid'],
  },
  async run(args) {
    const pid = Number.parseInt(args.pid, 10);
    if (!Number.isFinite(pid)) {
      return { ok: false, content: 'bash_kill: missing required integer argument "pid"' };
    }
    const signal = ALLOWED_SIGNALS.includes(args.signal) ? args.signal : 'SIGTERM';

    const entry = processes.getEntry(pid);
    if (!entry) {
      return { ok: false, content: `bash_kill: no process with pid ${pid}` };
    }

    let killed = false;
    if (entry.status === 'running') {
      killed = processes.kill(pid, signal);
    }

    if (args.remove === true) {
      processes.remove(pid);
    }

    if (entry.status !== 'running') {
      return {
        ok: true,
        content: `bash_kill: pid ${pid} was already exited (code=${entry.exitCode == null ? '?' : entry.exitCode}${entry.signal ? `, signal=${entry.signal}` : ''}).${args.remove ? ' Removed from registry.' : ''}`,
        data: { pid, killed: false, alreadyExited: true, removed: args.remove === true },
      };
    }
    return {
      ok: killed,
      content: killed
        ? `bash_kill: sent ${signal} to pid ${pid}.${args.remove ? ' Removed from registry.' : ''}`
        : `bash_kill: failed to send ${signal} to pid ${pid}.`,
      data: { pid, killed, signal, removed: args.remove === true },
    };
  },
};
