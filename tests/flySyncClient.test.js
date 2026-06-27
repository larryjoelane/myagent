// FlySyncSession tests. Uses real temp-dir filesystem operations (fs.watch
// needs a real fs) but stubs flyClient.exec so no real Fly Machines API or
// network call happens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FlySyncSession } = require('../src/core/fly/flySyncClient');
const { eq, ok, eventually } = require('./assert');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flysync-'));
}

// _request now passes the JSON body as a base64 argv (command[3]), not exec
// stdin — Fly's Machines exec API doesn't reliably deliver stdin (see the
// note on FlyClient.exec). This helper decodes it back for assertions.
function decodeBody(command) {
  return JSON.parse(Buffer.from(command[3], 'base64').toString('utf8'));
}

function fakeFlyClient({ exitCode = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async exec(appName, machineId, command, opts) {
      calls.push({ appName, machineId, command, opts });
      const body = command[3] ? decodeBody(command) : null;
      return { exit_code: exitCode, stdout: JSON.stringify({ ok: true }), stderr: '', _body: body };
    },
  };
}

function sessionOpts(flyClient, localRoot) {
  return { flyClient, appName: 'app', machineId: 'm1', syncAgentPort: 39201, localRoot };
}

exports.run = (t) => {
  t.test('pushFile execs a node script issuing a PUT with a path relative to the root', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'index.js');
    fs.writeFileSync(filePath, 'console.log(1)');
    const flyClient = fakeFlyClient();
    const session = new FlySyncSession(sessionOpts(flyClient, dir));
    await session.pushFile(filePath);

    eq(flyClient.calls.length, 1, 'one exec call');
    eq(flyClient.calls[0].appName, 'app', 'app name forwarded');
    eq(flyClient.calls[0].machineId, 'm1', 'machine id forwarded');
    eq(flyClient.calls[0].command[0], 'node', 'runs via node, not curl');
    const script = flyClient.calls[0].command[2];
    ok(script.includes('"PUT"'), 'method is PUT');
    ok(script.includes('/file') && script.includes('39201'), 'targets sync agent /file over localhost');
    eq(flyClient.calls[0].opts.stdin, undefined, 'does not use exec stdin');
    const body = decodeBody(flyClient.calls[0].command);
    eq(body.path, 'index.js', 'relative path computed from root');
    eq(body.content, 'console.log(1)', 'content read from disk');
  });

  t.test('pushFile on a single-file root uses just the basename', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, 'print(1)');
    const flyClient = fakeFlyClient();
    const session = new FlySyncSession(sessionOpts(flyClient, filePath));
    await session.pushFile(filePath);

    const body = decodeBody(flyClient.calls[0].command);
    eq(body.path, 'app.py', 'basename used as remote path');
  });

  t.test('pushAll walks a directory and pushes every file, skipping hidden dirs', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'b');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'skip');

    const flyClient = fakeFlyClient();
    const session = new FlySyncSession(sessionOpts(flyClient, dir));
    const count = await session.pushAll();

    eq(count, 2, 'pushes a.js and sub/b.js only');
    const paths = flyClient.calls.map((c) => decodeBody(c.command).path).sort();
    eq(paths.join(','), 'a.js,sub/b.js', 'excludes node_modules');
  });

  t.test('deleteFile execs a node script issuing a DELETE with the relative path', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'gone.js');
    fs.writeFileSync(filePath, 'x');
    const flyClient = fakeFlyClient();
    const session = new FlySyncSession(sessionOpts(flyClient, dir));
    await session.deleteFile(filePath);

    ok(flyClient.calls[0].command[2].includes('"DELETE"'), 'method is DELETE');
    eq(decodeBody(flyClient.calls[0].command).path, 'gone.js', 'relative path');
  });

  t.test('_request throws when the exec call exits non-zero', async () => {
    const dir = tmpDir();
    const flyClient = fakeFlyClient({ exitCode: 1 });
    const session = new FlySyncSession(sessionOpts(flyClient, dir));
    let threw = false;
    try {
      await session._request('PUT', '/file', { path: 'x', content: 'y' });
    } catch (err) {
      threw = true;
      ok(err.message.includes('exit 1'), 'error mentions exit code');
    }
    ok(threw, 'throws on non-zero exit');
  });

  t.test('startWatching pushes automatically when a watched file changes', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'watched.js');
    fs.writeFileSync(filePath, 'v1');
    const flyClient = fakeFlyClient();
    const session = new FlySyncSession(sessionOpts(flyClient, dir));
    const events = [];
    session.startWatching((kind, p) => events.push({ kind, p }));

    fs.writeFileSync(filePath, 'v2');

    await eventually(() => events.some((e) => e.kind === 'push'), { msg: 'waiting for auto-push' });
    const pushed = flyClient.calls.find((c) =>
      c.command[2].includes('"PUT"') && decodeBody(c.command).path === 'watched.js');
    ok(pushed, 'auto-pushed the changed file');
    session.close();
  });

  t.test('close() stops watchers from firing further pushes', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'closed.js');
    fs.writeFileSync(filePath, 'v1');
    const flyClient = fakeFlyClient();
    const session = new FlySyncSession(sessionOpts(flyClient, dir));
    session.startWatching();
    session.close();

    fs.writeFileSync(filePath, 'v2');
    await new Promise((r) => setTimeout(r, 200));
    eq(flyClient.calls.length, 0, 'no pushes after close');
  });
};
