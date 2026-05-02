// WorkerManager tests. The manager is the bridge between IPC handlers
// and worker channels — it owns spawning, naming, routing, and
// lifecycle. Driven via dependency injection (driverFactories +
// memoryStore) so tests don't touch real claude/shell/SQLite.

const { WorkerManager } = require('../src/core/workerManager');
const { eq, ok, contains, eventually } = require('./assert');

// Fake driver — same shape WorkerChannel expects.
class FakeDriver {
  constructor({ agentId, onEvent, kind }) {
    this.agentId = agentId;
    this.onEvent = onEvent;
    this.kind = kind || 'fake';
    this.sent = [];
    this.started = false;
    this.closed = false;
  }
  async start() { this.started = true; }
  async close() { this.closed = true; }
  send(text) { this.sent.push(text); }
  emit(name, payload = {}) { this.onEvent(name, { agentId: this.agentId, ...payload }); }
}

function fakeFactories() {
  // Each factory returns a fresh FakeDriver instance and stashes a
  // reference so tests can drive it.
  const created = { claude: [], shell: [] };
  return {
    factories: {
      claude: (opts) => { const d = new FakeDriver({ ...opts, kind: 'claude' }); created.claude.push(d); return d; },
      shell: (opts) => { const d = new FakeDriver({ ...opts, kind: 'shell' }); created.shell.push(d); return d; },
    },
    created,
  };
}

function recorder() {
  const events = [];
  return {
    events,
    onEvent(name, payload) { events.push({ name, payload }); },
    last(name) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].name === name) return events[i];
      return null;
    },
    countOf(name) { return events.filter((e) => e.name === name).length; },
  };
}

function fakeMemoryStore() {
  const stored = [];
  return {
    store(payload) { stored.push(payload); return Promise.resolve(); },
    stored,
  };
}

function run(t) {

  t.test('spawnWorker creates a claude-driven channel and returns id+name', async () => {
    const r = recorder();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    const result = await mgr.spawnWorker({ name: 'first' });
    ok(result.id, 'returned id');
    eq(result.name, 'first', 'returned name');
    eq(result.kind, 'claude', 'kind=claude');
    eq(created.claude.length, 1, 'one claude driver created');
    eq(created.shell.length, 0, 'no shell drivers');
    eq(created.claude[0].started, true, 'driver started');
  });

  t.test('spawnWorker auto-generates Worker N name when not provided', async () => {
    const r = recorder();
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    const a = await mgr.spawnWorker({});
    const b = await mgr.spawnWorker({});
    eq(a.name, 'Worker 1');
    eq(b.name, 'Worker 2');
  });

  t.test('spawnShell creates a shell-driven channel', async () => {
    const r = recorder();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    const result = await mgr.spawnShell({});
    eq(result.kind, 'shell');
    eq(result.name, 'shell', 'shell defaults to "shell" name');
    eq(created.shell.length, 1);
    eq(created.claude.length, 0);
  });

  t.test('list() reports active workers with id, name, kind', async () => {
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    await mgr.spawnWorker({ name: 'alpha' });
    await mgr.spawnShell({});
    const list = mgr.list();
    eq(list.length, 2, 'two workers listed');
    const alpha = list.find((w) => w.name === 'alpha');
    ok(alpha, 'alpha listed');
    eq(alpha.kind, 'claude');
    const shell = list.find((w) => w.kind === 'shell');
    ok(shell);
    eq(shell.name, 'shell');
  });

  t.test('send by id routes to the correct driver', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnWorker({ name: 'a' });
    const b = await mgr.spawnWorker({ name: 'b' });
    mgr.send({ to: a.id, text: 'msg-a' });
    mgr.send({ to: b.id, text: 'msg-b' });
    eq(created.claude[0].sent[0], 'msg-a', 'first driver got msg-a');
    eq(created.claude[1].sent[0], 'msg-b', 'second driver got msg-b');
  });

  t.test('send by name resolves to id', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    await mgr.spawnWorker({ name: 'frontend' });
    mgr.send({ to: 'frontend', text: 'do things' });
    eq(created.claude[0].sent[0], 'do things');
  });

  t.test('send to "shell" routes to the shell worker', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    await mgr.spawnShell({});
    mgr.send({ to: 'shell', text: 'ls' });
    eq(created.shell[0].sent[0], 'ls');
  });

  t.test('send to unknown target emits chat:error with helpful message', async () => {
    const r = recorder();
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    await mgr.spawnWorker({ name: 'real' });
    mgr.send({ to: 'ghost', text: 'hi' });
    const err = r.last('chat:error');
    ok(err, 'chat:error emitted');
    contains(err.payload.error, 'no worker', 'error mentions missing worker');
    contains(err.payload.error, 'real', 'error lists available workers');
  });

  t.test('close(id) shuts a worker down and removes from list', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnWorker({ name: 'gone' });
    await mgr.close(a.id);
    eq(created.claude[0].closed, true, 'driver closed');
    eq(mgr.list().length, 0, 'removed from list');
  });

  t.test('closeAll() shuts every worker', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    await mgr.spawnWorker({});
    await mgr.spawnWorker({});
    await mgr.spawnShell({});
    await mgr.closeAll();
    ok(created.claude.every((d) => d.closed), 'all claude drivers closed');
    ok(created.shell.every((d) => d.closed), 'all shell drivers closed');
    eq(mgr.list().length, 0);
  });

  t.test('events from drivers flow through to manager.onEvent', async () => {
    const r = recorder();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    await mgr.spawnWorker({ name: 'evt' });
    created.claude[0].emit('chat:turn-end', {
      userText: 'hi', assistantText: 'reply', ok: true,
    });
    eq(r.countOf('chat:turn-end'), 1);
    contains(r.last('chat:turn-end').payload.assistantText, 'reply');
  });

  t.test('memory mirror writes user+assistant on chat:turn-end when enabled', async () => {
    const memoryStore = fakeMemoryStore();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({
      factories,
      onEvent: () => {},
      memoryStore,
      memoryMirrorDefault: true,
    });
    const a = await mgr.spawnWorker({ name: 'mem' });
    created.claude[0].emit('chat:turn-end', {
      userText: 'remember this', assistantText: 'noted', ok: true,
    });
    // storeMemory may be async; let it settle.
    await new Promise((res) => setImmediate(res));
    eq(memoryStore.stored.length, 2, 'two rows stored (user + assistant)');
    contains(memoryStore.stored[0].text, 'remember this');
    contains(memoryStore.stored[0].source, a.id);
    contains(memoryStore.stored[1].text, 'noted');
    contains(memoryStore.stored[1].tags.join(','), 'assistant');
  });

  t.test('memory mirror skipped when default is off and no per-worker override', async () => {
    const memoryStore = fakeMemoryStore();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({
      factories,
      onEvent: () => {},
      memoryStore,
      memoryMirrorDefault: false,
    });
    await mgr.spawnWorker({});
    created.claude[0].emit('chat:turn-end', {
      userText: 'a', assistantText: 'b', ok: true,
    });
    await new Promise((res) => setImmediate(res));
    eq(memoryStore.stored.length, 0);
  });

  t.test('per-worker memory mirror override flips behavior', async () => {
    const memoryStore = fakeMemoryStore();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({
      factories,
      onEvent: () => {},
      memoryStore,
      memoryMirrorDefault: false,
    });
    const w = await mgr.spawnWorker({});
    mgr.setMirror({ id: w.id, on: true });
    created.claude[0].emit('chat:turn-end', {
      userText: 'a', assistantText: 'b', ok: true,
    });
    await new Promise((res) => setImmediate(res));
    eq(memoryStore.stored.length, 2);
  });

  t.test('rename(id, name) updates worker name and respects uniqueness', async () => {
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnWorker({ name: 'old' });
    const b = await mgr.spawnWorker({ name: 'other' });
    mgr.rename({ id: a.id, name: 'new-name' });
    eq(mgr.list().find((w) => w.id === a.id).name, 'new-name');
    let threw = false;
    try { mgr.rename({ id: a.id, name: 'other' }); }
    catch { threw = true; }
    ok(threw, 'duplicate rename rejected');
  });

  t.test('cwd is threaded through to driver factory and exposed on list()', async () => {
    let receivedCwd = null;
    const factories = {
      claude: (opts) => { receivedCwd = opts.cwd; return new FakeDriver(opts); },
      shell: (opts) => new FakeDriver(opts),
    };
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    await mgr.spawnWorker({ name: 'with-cwd', cwd: 'C:/some/path' });
    eq(receivedCwd, 'C:/some/path', 'driver received cwd');
    const listed = mgr.list().find((w) => w.name === 'with-cwd');
    eq(listed.cwd, 'C:/some/path', 'cwd appears in list output');
  });

  t.test('cwd defaults to undefined when not provided', async () => {
    let receivedCwd = 'unset';
    const factories = {
      claude: (opts) => { receivedCwd = opts.cwd; return new FakeDriver(opts); },
      shell: (opts) => new FakeDriver(opts),
    };
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    await mgr.spawnWorker({});
    eq(receivedCwd, undefined, 'driver got no cwd opt — driver decides default');
    eq(mgr.list()[0].cwd, undefined);
  });

  t.test('contextProvider gets called before send and its result is prepended', async () => {
    const { factories, created } = fakeFactories();
    const calls = [];
    const contextProvider = async ({ to, text }) => {
      calls.push({ to, text });
      return {
        preamble: '[Relevant past context]\nteam prefers postgres\n\n',
        usedHits: [{ id: 1, confidence: 0.81 }],
      };
    };
    const mgr = new WorkerManager({
      factories, onEvent: () => {}, contextProvider,
    });
    const a = await mgr.spawnWorker({ name: 'with-ctx' });
    mgr.send({ to: a.id, text: 'set up the db' });
    // Async — give the provider a moment to resolve before asserting.
    await new Promise((r) => setImmediate(r));
    eq(calls.length, 1, 'provider called once');
    eq(calls[0].text, 'set up the db', 'provider got the original text');
    eq(created.claude[0].sent.length, 1);
    contains(created.claude[0].sent[0], 'team prefers postgres');
    contains(created.claude[0].sent[0], 'set up the db');
  });

  t.test('contextProvider returning empty preamble = original text sent unchanged', async () => {
    const { factories, created } = fakeFactories();
    const contextProvider = async () => ({ preamble: '', usedHits: [] });
    const mgr = new WorkerManager({
      factories, onEvent: () => {}, contextProvider,
    });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'plain prompt' });
    await new Promise((r) => setImmediate(r));
    eq(created.claude[0].sent[0], 'plain prompt', 'no preamble = unchanged');
  });

  t.test('contextProvider not provided = no injection (backwards-compatible)', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'plain prompt' });
    await new Promise((r) => setImmediate(r));
    eq(created.claude[0].sent[0], 'plain prompt', 'no provider = unchanged');
  });

  t.test('contextProvider failure does not block the send', async () => {
    const r = recorder();
    const { factories, created } = fakeFactories();
    const contextProvider = async () => { throw new Error('boom'); };
    const mgr = new WorkerManager({
      factories, onEvent: r.onEvent, contextProvider,
    });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'plain prompt' });
    await new Promise((r) => setImmediate(r));
    eq(created.claude[0].sent[0], 'plain prompt', 'fall through on provider error');
  });

  t.test('chat:user event reflects the ORIGINAL text (not the augmented one)', async () => {
    // Users see what they typed, not the auto-injected preamble.
    // The driver and the upstream UI both need to know what to show.
    // We pass usedHits via a separate event so the UI can render a badge.
    const r = recorder();
    const { factories, created } = fakeFactories();
    const contextProvider = async () => ({
      preamble: '[ctx]\n\n',
      usedHits: [{ id: 7, confidence: 0.7, snippet: 'past memory' }],
    });
    const mgr = new WorkerManager({
      factories, onEvent: r.onEvent, contextProvider,
    });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'real prompt' });
    await new Promise((r) => setImmediate(r));
    // Manager emits chat:context-used so UI can render a badge.
    const used = r.last('chat:context-used');
    ok(used, 'chat:context-used emitted');
    eq(used.payload.userText, 'real prompt');
    eq(used.payload.usedHits.length, 1);
    eq(used.payload.usedHits[0].id, 7);
  });

  t.test('chat:driver-exit causes worker to be removed from list', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnWorker({});
    eq(mgr.list().length, 1);
    created.claude[0].emit('chat:driver-exit', { code: 1 });
    // Auto-cleanup may be deferred; allow microtasks to flush.
    await new Promise((res) => setImmediate(res));
    eq(mgr.list().length, 0, 'worker removed after driver exits');
  });
}

module.exports = { run };
