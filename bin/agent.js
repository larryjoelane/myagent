#!/usr/bin/env node
// CLI for the multi-terminal agent registry. Each terminal that wants to
// participate in leader/worker coordination calls these subcommands.
//
// Identity: register returns an id which is then passed back via
// MYAGENT_AGENT_ID (env var) on subsequent calls. Most subcommands read
// the id from the env to keep invocations terse.
//
// Usage:
//   node bin/agent.js register [--name foo] [--role leader|worker]
//   node bin/agent.js heartbeat [--id ID]
//   node bin/agent.js send <to> <text...>          to = id | "leader" | "broadcast"
//   node bin/agent.js inbox [--id ID]
//   node bin/agent.js list
//   node bin/agent.js unregister [--id ID]
//
// All commands require the loopback server to be up — i.e., the Electron
// app must be running. There's no in-process fallback for coordination.

const path = require('path');
const sessionClient = require('../src/core/sessionClient');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(PROJECT_ROOT, '.myagent', 'sessions');

function printHelp() {
  process.stderr.write([
    'agent — multi-terminal agent registry CLI',
    '',
    'Usage:',
    '  agent register [--name N] [--role leader|worker]',
    '  agent heartbeat [--id ID]',
    '  agent send <to> <text...>          to = <id> | "leader" | "broadcast"',
    '  agent inbox [--id ID]',
    '  agent list',
    '  agent unregister [--id ID]',
    '',
    'Env:',
    '  MYAGENT_AGENT_ID    default agent id for subcommands',
    '  MYAGENT_SESSIONS_DIR  override sessions dir (default: <repo>/.myagent/sessions)',
    '',
  ].join('\n') + '\n');
}

function pickFlag(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) {
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    }
  }
  return null;
}

async function getRemote() {
  const remote = await sessionClient.tryConnect(SESSIONS_DIR);
  if (!remote) {
    process.stderr.write('agent: no MyAgent server running (start the Electron app)\n');
    process.exit(3);
  }
  return remote;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (!cmd || cmd === '-h' || cmd === '--help') { printHelp(); process.exit(cmd ? 0 : 2); }

  const remote = await getRemote();

  if (cmd === 'register') {
    const name = pickFlag(argv, '--name', '-n');
    const role = pickFlag(argv, '--role', '-r');
    const r = await remote.agentRegister({ name, role, pid: process.pid });
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (cmd === 'heartbeat') {
    const id = pickFlag(argv, '--id') || process.env.MYAGENT_AGENT_ID;
    if (!id) { process.stderr.write('agent heartbeat: --id or MYAGENT_AGENT_ID required\n'); process.exit(2); }
    const r = await remote.agentHeartbeat({ id });
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (cmd === 'send') {
    const from = pickFlag(argv, '--from') || process.env.MYAGENT_AGENT_ID;
    if (!from) { process.stderr.write('agent send: --from or MYAGENT_AGENT_ID required\n'); process.exit(2); }
    const to = argv.shift();
    const text = argv.join(' ').trim();
    if (!to || !text) { process.stderr.write('agent send: usage: send <to> <text...>\n'); process.exit(2); }
    const r = await remote.agentSend({ from, to, text });
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (cmd === 'inbox') {
    const id = pickFlag(argv, '--id') || process.env.MYAGENT_AGENT_ID;
    if (!id) { process.stderr.write('agent inbox: --id or MYAGENT_AGENT_ID required\n'); process.exit(2); }
    const r = await remote.agentInbox(id);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  if (cmd === 'list') {
    const r = await remote.agentList();
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  if (cmd === 'unregister') {
    const id = pickFlag(argv, '--id') || process.env.MYAGENT_AGENT_ID;
    if (!id) { process.stderr.write('agent unregister: --id or MYAGENT_AGENT_ID required\n'); process.exit(2); }
    const r = await remote.agentUnregister({ id });
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }

  process.stderr.write(`agent: unknown command "${cmd}"\n`);
  printHelp();
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`agent failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
