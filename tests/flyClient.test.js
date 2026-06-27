// FlyClient tests. Stubs global fetch so no real Fly API calls happen;
// asserts request shape (method/path/headers/body) and response handling.

const { FlyClient, FlyApiError } = require('../src/core/fly/flyClient');
const { eq, ok, deepEq } = require('./assert');

function stubFetch(responses) {
  const calls = [];
  let i = 0;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  return calls;
}

exports.run = (t) => {
  const originalFetch = global.fetch;
  const restore = () => { global.fetch = originalFetch; };

  t.test('constructor requires an api token', () => {
    const saved = process.env.FLY_API_TOKEN;
    delete process.env.FLY_API_TOKEN;
    try {
      let threw = false;
      try { new FlyClient(); } catch { threw = true; }
      ok(threw, 'expected constructor to throw without a token');
    } finally {
      if (saved !== undefined) process.env.FLY_API_TOKEN = saved;
    }
  });

  t.test('ensureApp posts to /apps with org_slug', async () => {
    const calls = stubFetch([{ status: 201, body: { app_name: 'my-app' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok', org: 'my-org' });
      const result = await client.ensureApp('my-app');
      eq(calls.length, 1, 'one fetch call');
      eq(calls[0].init.method, 'POST', 'method');
      ok(calls[0].url.endsWith('/apps'), 'url targets /apps');
      eq(calls[0].init.headers.Authorization, 'Bearer tok', 'auth header');
      deepEq(JSON.parse(calls[0].init.body), { app_name: 'my-app', org_slug: 'my-org' }, 'body');
      deepEq(result, { app_name: 'my-app' }, 'result');
    } finally { restore(); }
  });

  t.test('ensureApp treats 422 (already exists) as success', async () => {
    stubFetch([{ status: 422, body: { error: 'name already taken' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const result = await client.ensureApp('taken-app');
      ok(result.already_exists, 'reports already_exists');
    } finally { restore(); }
  });

  t.test('ensureApp rethrows non-422 errors as FlyApiError', async () => {
    stubFetch([{ status: 500, body: { error: 'boom' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      let caught = null;
      try { await client.ensureApp('app'); } catch (err) { caught = err; }
      ok(caught instanceof FlyApiError, 'is a FlyApiError');
      eq(caught.status, 500, 'status carried through');
    } finally { restore(); }
  });

  t.test('createMachine posts machine config to /apps/:app/machines', async () => {
    const calls = stubFetch([{ status: 200, body: { id: 'm1', state: 'created' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const config = { image: 'flyio/hellofly:latest', env: { PORT: '8080' } };
      const result = await client.createMachine('my-app', config, { name: 'web-1', region: 'iad' });
      ok(calls[0].url.endsWith('/apps/my-app/machines'), 'url targets machines endpoint');
      deepEq(JSON.parse(calls[0].init.body), { name: 'web-1', region: 'iad', config }, 'body');
      eq(result.id, 'm1', 'returns parsed response');
    } finally { restore(); }
  });

  t.test('getMachine issues a GET to the machine resource', async () => {
    const calls = stubFetch([{ status: 200, body: { id: 'm1', state: 'started' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const result = await client.getMachine('my-app', 'm1');
      eq(calls[0].init.method, 'GET', 'method');
      ok(calls[0].url.endsWith('/apps/my-app/machines/m1'), 'url');
      eq(result.state, 'started', 'parsed state');
    } finally { restore(); }
  });

  t.test('waitForState polls until the target state is reached', async () => {
    stubFetch([
      { status: 200, body: { id: 'm1', state: 'created' } },
      { status: 200, body: { id: 'm1', state: 'starting' } },
      { status: 200, body: { id: 'm1', state: 'started' } },
    ]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const result = await client.waitForState('my-app', 'm1', 'started', { intervalMs: 1 });
      eq(result.state, 'started', 'reaches target state');
    } finally { restore(); }
  });

  t.test('waitForState times out if the target state never arrives', async () => {
    stubFetch([{ status: 200, body: { id: 'm1', state: 'created' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      let caught = null;
      try {
        await client.waitForState('my-app', 'm1', 'started', { timeoutMs: 10, intervalMs: 5 });
      } catch (err) { caught = err; }
      ok(caught, 'throws on timeout');
      ok(caught.message.includes('timed out'), 'message mentions timeout');
    } finally { restore(); }
  });

  t.test('updateMachineConfig posts the full config to the machine resource', async () => {
    const calls = stubFetch([{ status: 200, body: { id: 'm1', state: 'started' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const config = { image: 'node:20-slim', services: [{ internal_port: 8080, ports: [{ port: 443 }] }] };
      const result = await client.updateMachineConfig('my-app', 'm1', config, { region: 'iad' });
      eq(calls[0].init.method, 'POST', 'method');
      ok(calls[0].url.endsWith('/apps/my-app/machines/m1'), 'url targets the machine resource (not /exec)');
      deepEq(JSON.parse(calls[0].init.body), { region: 'iad', config }, 'body carries region + full config');
      eq(result.id, 'm1', 'returns parsed response');
    } finally { restore(); }
  });

  t.test('destroyMachine issues a DELETE, optionally with force=true', async () => {
    const calls = stubFetch([{ status: 200, body: { ok: true } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      await client.destroyMachine('my-app', 'm1', { force: true });
      eq(calls[0].init.method, 'DELETE', 'method');
      ok(calls[0].url.endsWith('/apps/my-app/machines/m1?force=true'), 'url includes force flag');
    } finally { restore(); }
  });

  t.test('exec posts command (and optional stdin) to the exec endpoint', async () => {
    const calls = stubFetch([{ status: 200, body: { stdout: 'hi\n', stderr: '', exit_code: 0 } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const result = await client.exec('my-app', 'm1', ['sh', '-c', 'cat > /agent.js'], { stdin: 'console.log(1)' });
      eq(calls[0].init.method, 'POST', 'method');
      ok(calls[0].url.endsWith('/apps/my-app/machines/m1/exec'), 'url targets exec endpoint');
      deepEq(JSON.parse(calls[0].init.body), {
        command: ['sh', '-c', 'cat > /agent.js'],
        stdin: 'console.log(1)',
      }, 'body');
      eq(result.exit_code, 0, 'returns parsed response');
    } finally { restore(); }
  });

  t.test('exec omits stdin/timeout from the body when not provided', async () => {
    const calls = stubFetch([{ status: 200, body: { stdout: '', stderr: '', exit_code: 0 } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      await client.exec('my-app', 'm1', ['true']);
      deepEq(JSON.parse(calls[0].init.body), { command: ['true'] }, 'body has only command');
    } finally { restore(); }
  });

  t.test('writeFileViaArgv sends a node -e decoder with the path and base64 content as argv, not stdin', async () => {
    const calls = stubFetch([{ status: 200, body: { stdout: '', stderr: '', exit_code: 0 } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      await client.writeFileViaArgv('my-app', 'm1', '/agent.js', 'hello world', { timeout: 30 });
      const body = JSON.parse(calls[0].init.body);
      eq(body.stdin, undefined, 'does not use stdin');
      eq(body.timeout, 30, 'forwards timeout');
      deepEq(body.command.slice(0, 2), ['node', '-e'], 'runs a node -e decoder script');
      eq(body.command[3], '/agent.js', 'fourth arg is the destination path');
      eq(Buffer.from(body.command[4], 'base64').toString('utf8'), 'hello world', 'fifth arg decodes back to the original content');
    } finally { restore(); }
  });

  t.test('listVolumes issues a GET to the app volumes endpoint', async () => {
    const calls = stubFetch([{ status: 200, body: [{ id: 'vol1', name: 'myagent_my_app' }] }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const result = await client.listVolumes('my-app');
      eq(calls[0].init.method, 'GET', 'method');
      ok(calls[0].url.endsWith('/apps/my-app/volumes'), 'url targets volumes endpoint');
      eq(result[0].id, 'vol1', 'returns parsed response');
    } finally { restore(); }
  });

  t.test('createVolume posts name/region/size_gb to the volumes endpoint', async () => {
    const calls = stubFetch([{ status: 201, body: { id: 'vol1', name: 'myagent_my_app' } }]);
    try {
      const client = new FlyClient({ apiToken: 'tok' });
      const result = await client.createVolume('my-app', 'myagent_my_app', { region: 'iad', sizeGb: 1 });
      eq(calls[0].init.method, 'POST', 'method');
      ok(calls[0].url.endsWith('/apps/my-app/volumes'), 'url targets volumes endpoint');
      deepEq(JSON.parse(calls[0].init.body), { name: 'myagent_my_app', region: 'iad', size_gb: 1 }, 'body');
      eq(result.id, 'vol1', 'returns parsed response');
    } finally { restore(); }
  });
};
