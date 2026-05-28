// bash_list — list every background bash process the worker is tracking.
// Running entries come first, then recently-exited ones.

const processes = require('../bash/processes');

module.exports = {
  name: 'bash_list',
  description:
    'List every background bash process this worker is tracking. ' +
    'Running entries first, then recently-exited. Use to discover pids ' +
    'you started in earlier turns.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async run() {
    const entries = processes.list();
    if (entries.length === 0) {
      return { ok: true, content: '(no background processes)', data: { entries: [] } };
    }
    const lines = entries.map((e) => {
      const uptime = `${Math.round(e.uptimeMs / 1000)}s`;
      const status = e.status === 'running'
        ? 'running'
        : `exited code=${e.exitCode == null ? '?' : e.exitCode}${e.signal ? ` signal=${e.signal}` : ''}`;
      return `pid=${e.pid} ${status} uptime=${uptime} cwd=${e.cwd}\n  $ ${e.command}`;
    });
    return {
      ok: true,
      content: lines.join('\n'),
      data: { entries },
    };
  },
};
