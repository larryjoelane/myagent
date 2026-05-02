const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryStore } = require('../src/store');
const { dispatch, buildTools, PROTOCOL_VERSION } = require('../src/mcp');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-mcp-test-'));
  const s = new MemoryStore({ dir });
  s.load();
  return s;
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

test('initialize returns server info and protocol version', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(rpc('initialize'), { tools, server: { store } });
  assert.equal(reply.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(reply.result.serverInfo.name, 'myagent-memory-mcp');
  assert.ok(reply.result.capabilities.tools);
});

test('tools/list advertises every tool with a schema', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(rpc('tools/list'), { tools, server: { store } });
  const names = reply.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['memory_delete', 'memory_list', 'memory_search', 'memory_store']);
  for (const t of reply.result.tools) {
    assert.ok(t.description);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('tools/call memory_store then memory_search round-trips', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  await dispatch(
    rpc('tools/call', { name: 'memory_store', arguments: { text: 'kubernetes notes about pod scheduling' } }),
    { tools, server: { store } },
  );
  const reply = await dispatch(
    rpc('tools/call', { name: 'memory_search', arguments: { query: 'kubernetes' } }),
    { tools, server: { store } },
  );
  assert.ok(reply.result.content[0].text.includes('kubernetes'));
});

test('tools/call rejects missing required argument', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(
    rpc('tools/call', { name: 'memory_store', arguments: {} }),
    { tools, server: { store } },
  );
  assert.equal(reply.error.code, -32602);
  assert.match(reply.error.message, /text/);
});

test('tools/call unknown tool returns -32602', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(
    rpc('tools/call', { name: 'nope', arguments: {} }),
    { tools, server: { store } },
  );
  assert.equal(reply.error.code, -32602);
});

test('unknown method returns -32601', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(rpc('does/not/exist'), { tools, server: { store } });
  assert.equal(reply.error.code, -32601);
});

test('notifications/initialized returns null (no reply)', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, { tools, server: { store } });
  assert.equal(reply, null);
});

test('memory_delete on missing id returns isError content', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(
    rpc('tools/call', { name: 'memory_delete', arguments: { id: 999 } }),
    { tools, server: { store } },
  );
  assert.equal(reply.result.isError, true);
});

test('memory_search returns "No matches" when empty', async () => {
  const store = tmpStore();
  const tools = buildTools(store);
  const reply = await dispatch(
    rpc('tools/call', { name: 'memory_search', arguments: { query: 'anything' } }),
    { tools, server: { store } },
  );
  assert.match(reply.result.content[0].text, /No matches/i);
});
