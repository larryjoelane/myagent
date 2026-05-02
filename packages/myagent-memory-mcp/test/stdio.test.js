// End-to-end smoke test: spawn bin/mcp.js as a real subprocess, drive it
// over stdio, and verify the framed JSON-RPC contract is respected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-mcp-stdio-'));
}

function start({ dir }) {
  const bin = path.resolve(__dirname, '..', 'bin', 'mcp.js');
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, MYAGENT_MEMORY_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });
  // Drain stderr — the server logs a banner there. We don't assert on it
  // but consuming prevents the pipe from filling.
  child.stderr.on('data', () => {});

  let nextId = 1;
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 5000);
    });
  }
  function close() {
    return new Promise((resolve) => {
      child.on('exit', () => resolve());
      child.stdin.end();
    });
  }
  return { call, close };
}

test('spawned server handles initialize -> store -> search round trip', async () => {
  const dir = tmpDir();
  const srv = start({ dir });
  try {
    const init = await srv.call('initialize', {});
    assert.equal(init.result.serverInfo.name, 'myagent-memory-mcp');

    await srv.call('tools/call', {
      name: 'memory_store',
      arguments: { text: 'rust borrow checker prefers explicit lifetimes here', source: 'test' },
    });

    const list = await srv.call('tools/list', {});
    assert.ok(list.result.tools.find((t) => t.name === 'memory_search'));

    const search = await srv.call('tools/call', {
      name: 'memory_search',
      arguments: { query: 'rust lifetimes' },
    });
    assert.match(search.result.content[0].text, /borrow checker/);
  } finally {
    await srv.close();
  }
});
