// WorkerManager tests. The manager is the bridge between IPC handlers
// and worker channels — it owns spawning, naming, routing, and
// lifecycle. Driven via dependency injection (driverFactories +
// memoryStore) so tests don't touch real claude/shell/SQLite.

const { WorkerManager } = require('../src/core/workerManager');
const { eq, ok, contains, eventually, deepEq } = require('./assert');

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
  // reference so tests can drive it. The driver also captures the
  // full opts object so tests can assert kind-specific args (model,
  // cwd, etc.) flow through.
  const created = { claude: [], shell: [], 'ollama-cloud': [] };
  function track(kind) {
    return (opts) => {
      const d = new FakeDriver({ ...opts, kind });
      d.opts = opts;
      created[kind].push(d);
      return d;
    };
  }
  return {
    factories: {
      claude: track('claude'),
      shell: track('shell'),
      'ollama-cloud': track('ollama-cloud'),
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
  const stored = [];   // legacy single-text store() calls
  const turns = [];    // MySecondBrain storeTurn() calls (one per Q+A turn)
  return {
    store(payload) { stored.push(payload); return Promise.resolve(); },
    storeTurn(turn) { turns.push(turn); return Promise.resolve({ id: turns.length }); },
    stored,
    turns,
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

  t.test('memory mirror writes ONE Q+A turn on chat:turn-end when enabled', async () => {
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
      provider: 'openrouter', totals: { model: 'openai/gpt-5-nano' },
    });
    // storeTurn may be async; let it settle.
    await new Promise((res) => setImmediate(res));
    // ONE combined turn, not two separate rows (the old unlinked design).
    eq(memoryStore.turns.length, 1, 'one Q+A turn stored');
    const turn = memoryStore.turns[0];
    eq(turn.prompt, 'remember this');
    eq(turn.answer, 'noted');
    eq(turn.workerId, a.id);
    eq(turn.provider, 'openrouter');
    eq(turn.model, 'openai/gpt-5-nano');
    // Legacy two-row store() path is no longer used by the mirror.
    eq(memoryStore.stored.length, 0, 'no legacy single-text rows');
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
    eq(memoryStore.turns.length, 0);
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
    eq(memoryStore.turns.length, 1);
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

  t.test('slash commands bypass auto-context (preamble would break parseSlash)', async () => {
    const { factories, created } = fakeFactories();
    let providerCalled = 0;
    const contextProvider = async () => {
      providerCalled++;
      return { preamble: '[Relevant past context — use if helpful]\n\n', usedHits: [{ id: 1 }] };
    };
    const mgr = new WorkerManager({ factories, onEvent: () => {}, contextProvider });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: '/help' });
    await new Promise((r) => setImmediate(r));
    eq(providerCalled, 0, 'provider must not run for slash commands');
    eq(created.claude[0].sent[0], '/help', 'slash text reaches driver verbatim');
  });

  t.test('listTools returns the toolkit for workers whose driver exposes one', async () => {
    // Generic mechanism: any driver that exposes a `toolkit` with list()
    // surfaces its tools via listTools(). Use a FakeDriver with an injected
    // toolkit (no real driver depends on this today, but the plumbing does).
    const toolkit = {
      list: () => [
        { id: 'foo', name: 'Foo', description: 'foo desc', usage: ['/foo bar'] },
        { id: 'baz', name: 'Baz', description: 'baz desc' },
      ],
    };
    const toolFactory = ({ agentId, onEvent }) => {
      const d = new FakeDriver({ agentId, onEvent, kind: 'tooly' });
      d.toolkit = toolkit;
      return d;
    };
    const { factories: base } = fakeFactories();
    const mgr = new WorkerManager({
      factories: { ...base, claude: toolFactory },
      onEvent: () => {},
    });
    const w = await mgr.spawnWorker({});
    const tools = mgr.listTools(w.id);
    eq(tools.length, 2, 'two tools');
    eq(tools[0].id, 'foo');
    eq(tools[0].name, 'Foo');
    deepEq(tools[0].usage, ['/foo bar']);
    deepEq(tools[1].usage, [], 'missing usage normalized to []');
  });

  t.test('listTools returns null for workers without a toolkit (claude/shell)', async () => {
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnWorker({});
    const b = await mgr.spawnShell({});
    eq(mgr.listTools(a.id), null);
    eq(mgr.listTools(b.id), null);
    eq(mgr.listTools('does-not-exist'), null);
  });

  t.test('claude workers still get auto-context (regression guard)', async () => {
    const { factories, created } = fakeFactories();
    let providerCalled = 0;
    const contextProvider = async () => {
      providerCalled++;
      return { preamble: '[ctx]\n\n', usedHits: [] };
    };
    const mgr = new WorkerManager({ factories, onEvent: () => {}, contextProvider });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'plain prompt' });
    await new Promise((r) => setImmediate(r));
    eq(providerCalled, 1, 'provider must still run for claude workers');
    eq(created.claude[0].sent[0], '[ctx]\n\nplain prompt');
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
    // The driver receives the augmented prompt for the model, but the
    // manager rewrites chat:user back to the original before forwarding
    // — otherwise the augmented text shows up in the user bubble AND
    // gets mirrored to memory, where it'd be retrieved next turn and
    // augmented again (recursive preamble loop).
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
    // Driver received the AUGMENTED prompt (preamble + text) — that's
    // the input the model needs.
    eq(created.claude[0].sent[0], '[ctx]\n\nreal prompt', 'driver got augmented');
    // Now have the driver emit chat:user back upward (real drivers do
    // this; FakeDriver needs an explicit nudge).
    created.claude[0].emit('chat:user', { text: '[ctx]\n\nreal prompt' });
    const userEv = r.last('chat:user');
    ok(userEv, 'chat:user emitted');
    eq(userEv.payload.text, 'real prompt', 'manager rewrote text to original');
  });

  t.test('chat:turn-end.userText is rewritten to original for memory mirror', async () => {
    // The mirror writes payload.userText. If it sees the augmented text
    // we get a recursive preamble loop on subsequent turns. The manager
    // must rewrite it back to the original before mirroring.
    const memory = fakeMemoryStore();
    const { factories, created } = fakeFactories();
    const contextProvider = async () => ({
      preamble: '[ctx]\n\n',
      usedHits: [{ id: 9, confidence: 0.6, snippet: 'past' }],
    });
    const mgr = new WorkerManager({
      factories, onEvent: () => {}, contextProvider,
      memoryStore: memory, memoryMirrorDefault: true,
    });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'remember this' });
    await new Promise((r) => setImmediate(r));
    // Driver emits turn-end with the augmented userText (real drivers
    // echo whatever they received).
    created.claude[0].emit('chat:turn-end', {
      userText: '[ctx]\n\nremember this',
      assistantText: 'sure',
      ok: true,
    });
    await new Promise((r) => setImmediate(r));
    const turn = memory.turns[0];
    ok(turn, 'turn mirrored');
    eq(turn.prompt, 'remember this', 'mirror got the ORIGINAL prompt, not the augmented one');
    eq(turn.answer, 'sure', 'answer captured');
  });

  t.test('no auto-context = no rewrite (passthrough)', async () => {
    // Pure regression guard: when contextProvider returns no preamble,
    // chat:user must pass through unchanged. We don't want the rewrite
    // path to accidentally swallow legitimate driver echoes.
    const r = recorder();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'plain' });
    await new Promise((r) => setImmediate(r));
    created.claude[0].emit('chat:user', { text: 'plain' });
    eq(r.last('chat:user').payload.text, 'plain');
  });

  t.test('originalText: caller-augmented send still rewrites chat:user back to the original', async () => {
    // Renderer-side /attach prepends a preamble before invoking
    // worker:send. The chat UI shows the typed text, not the file
    // content; chat:user must reflect that, just like auto-context.
    const r = recorder();
    let providerCalled = 0;
    const { factories, created } = fakeFactories();
    const contextProvider = async () => { providerCalled++; return { preamble: 'IGNORED', usedHits: [] }; };
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent, contextProvider });
    const a = await mgr.spawnWorker({});
    mgr.send({
      to: a.id,
      text: '[Attached: a.js]\n```\nx\n```\n\nfix this',
      originalText: 'fix this',
    });
    await new Promise((r) => setImmediate(r));
    // Provider must NOT have been called — caller-augmented sends
    // skip the auto-context wrapper.
    eq(providerCalled, 0, 'caller augmentation bypasses contextProvider');
    // Driver received the augmented (full) text.
    eq(created.claude[0].sent[0], '[Attached: a.js]\n```\nx\n```\n\nfix this');
    // Now simulate the driver echoing chat:user with the augmented
    // text — manager rewrites it back to the user's original.
    created.claude[0].emit('chat:user', { text: '[Attached: a.js]\n```\nx\n```\n\nfix this' });
    eq(r.last('chat:user').payload.text, 'fix this');
  });

  t.test('originalText: turn-end userText is rewritten too (memory mirror sees the original)', async () => {
    const r = recorder();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    const a = await mgr.spawnWorker({});
    mgr.send({
      to: a.id,
      text: '[Attached: x.go]\nbody\n\noriginal',
      originalText: 'original',
    });
    await new Promise((r) => setImmediate(r));
    created.claude[0].emit('chat:turn-end', {
      userText: '[Attached: x.go]\nbody\n\noriginal',
      assistantText: 'reply',
    });
    eq(r.last('chat:turn-end').payload.userText, 'original');
  });

  t.test('originalText equal to text = no rewrite (treated as a normal send)', async () => {
    const r = recorder();
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'hello', originalText: 'hello' });
    await new Promise((r) => setImmediate(r));
    eq(created.claude[0].sent[0], 'hello');
    created.claude[0].emit('chat:user', { text: 'hello' });
    eq(r.last('chat:user').payload.text, 'hello');
  });

  t.test('chat:context-used carries fileSource when the provider returned one', async () => {
    const r = recorder();
    const { factories } = fakeFactories();
    const contextProvider = async () => ({
      preamble: '[Active editor: /p/foo.js]\n```js\nx\n```\n',
      usedHits: [],
      fileSource: { path: '/p/foo.js', dirty: true },
    });
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent, contextProvider });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'hello' });
    await new Promise((r) => setImmediate(r));
    const ev = r.last('chat:context-used');
    ok(ev, 'chat:context-used emitted');
    deepEq(ev.payload.fileSource, { path: '/p/foo.js', dirty: true });
    deepEq(ev.payload.usedHits, []);
  });

  t.test('chat:context-used is NOT emitted when neither memory nor file context applied', async () => {
    const r = recorder();
    const { factories } = fakeFactories();
    const contextProvider = async () => ({ preamble: '', usedHits: [], fileSource: null });
    const mgr = new WorkerManager({ factories, onEvent: r.onEvent, contextProvider });
    const a = await mgr.spawnWorker({});
    mgr.send({ to: a.id, text: 'hello' });
    await new Promise((r) => setImmediate(r));
    eq(r.countOf('chat:context-used'), 0);
  });

  // ---- Per-worker scope (ADR-0008) ------------------------------------
  t.test('per-worker scope: spawn seeds Scope with [cwd, ...editorRoots]', async () => {
    const { Scope } = require('../src/core/scope');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const editorScope = new Scope([os.tmpdir()]);
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {}, editorScope });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-scope-'));
    try {
      const a = await mgr.spawnWorker({ cwd });
      const opts = created.claude[0].opts || {};
      ok(opts.scope, 'factory received scope');
      const roots = opts.scope.list();
      ok(opts.scope.containsSync(cwd), 'cwd in scope');
      ok(opts.scope.containsSync(os.tmpdir()), 'editor root in scope');
      ok(roots.length >= 2, `expected ≥2 roots, got: ${roots.join(', ')}`);
      const listed = mgr.listScope({ id: a.id });
      eq(listed.ok, true);
      ok(listed.roots.length >= 2);
      eq(listed.cwd, cwd);
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('per-worker scope: editorScope mutations after spawn do NOT propagate (snapshot at spawn)', async () => {
    const { Scope } = require('../src/core/scope');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    // Use an isolated parent so otherDir isn't a descendant of the
    // initial editor scope root (which would make containsSync true
    // because of transitive reach, masking the snapshot semantics).
    const isoParent = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-iso-'));
    const initialEditorRoot = fs.mkdtempSync(path.join(isoParent, 'init-'));
    const editorScope = new Scope([initialEditorRoot]);
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {}, editorScope });
    const cwd = fs.mkdtempSync(path.join(isoParent, 'cwd-'));
    const otherDir = fs.mkdtempSync(path.join(isoParent, 'other-'));
    try {
      await mgr.spawnWorker({ cwd });
      const workerScope = created.claude[0].opts.scope;
      // Sanity: before mutation, otherDir is NOT in the worker's scope.
      ok(!workerScope.containsSync(otherDir), 'precondition: otherDir not in scope');
      // Add to editor scope AFTER spawn.
      await editorScope.add(otherDir);
      // Worker scope should NOT have picked it up.
      ok(!workerScope.containsSync(otherDir), 'post-spawn editor mutation does not leak');
    } finally {
      try { fs.rmSync(isoParent, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('addScope: extends a worker scope; listScope reflects the new root', async () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-add-'));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-add-extra-'));
    try {
      const a = await mgr.spawnWorker({ cwd });
      const before = mgr.listScope({ id: a.id }).roots.length;
      const r = await mgr.addScope({ id: a.id, path: extra });
      eq(r.ok, true);
      ok(r.roots.length > before, 'roots count grew');
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(extra, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('removeScope: refuses to remove the cwd (spawn-time fence is non-removable)', async () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fence-'));
    try {
      const a = await mgr.spawnWorker({ cwd });
      const r = await mgr.removeScope({ id: a.id, path: cwd });
      eq(r.ok, false);
      contains(String(r.error), 'cwd');
      const listed = mgr.listScope({ id: a.id });
      ok(listed.roots.some((root) => root.toLowerCase() === cwd.toLowerCase()),
        'cwd remains in scope after refusal');
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('removeScope: removes a non-cwd root', async () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-rm-'));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-rm-extra-'));
    try {
      const a = await mgr.spawnWorker({ cwd });
      await mgr.addScope({ id: a.id, path: extra });
      const before = mgr.listScope({ id: a.id }).roots.length;
      const r = await mgr.removeScope({ id: a.id, path: extra });
      eq(r.ok, true);
      eq(r.removed, true);
      const after = mgr.listScope({ id: a.id }).roots.length;
      ok(after < before, 'root count dropped');
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(extra, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('addScope/removeScope/listScope return clean errors for unknown worker id', async () => {
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    eq(mgr.listScope({ id: 'nope' }).ok, false);
    const a = await mgr.addScope({ id: 'nope', path: '/tmp' });
    eq(a.ok, false);
    const b = await mgr.removeScope({ id: 'nope', path: '/tmp' });
    eq(b.ok, false);
  });

  t.test('list() includes scopeRoots for every worker', async () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-list-'));
    try {
      await mgr.spawnWorker({ cwd });
      const list = mgr.list();
      eq(list.length, 1);
      ok(Array.isArray(list[0].scopeRoots));
      ok(list[0].scopeRoots.length >= 1);
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  t.test('spawnOllamaCloud threads model + cwd into the factory', async () => {
    const { factories, created } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const result = await mgr.spawnOllamaCloud({ model: 'ibm/granite-docling', cwd: '/tmp' });
    eq(result.kind, 'ollama-cloud');
    contains(result.name, 'granite-docling');
    eq(created['ollama-cloud'].length, 1);
    const drv = created['ollama-cloud'][0];
    eq(drv.opts.model, 'ibm/granite-docling');
    eq(drv.opts.cwd, '/tmp');
  });

  t.test('spawnOllamaCloud falls back to plain "Ollama N" when no model picked', async () => {
    const { factories } = fakeFactories();
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    const a = await mgr.spawnOllamaCloud({});
    const b = await mgr.spawnOllamaCloud({});
    eq(a.name, 'Ollama 1');
    eq(b.name, 'Ollama 2');
  });

  t.test('spawnOllamaCloud throws when factory not registered', async () => {
    const { factories } = fakeFactories();
    delete factories['ollama-cloud'];
    const mgr = new WorkerManager({ factories, onEvent: () => {} });
    let err = null;
    try { await mgr.spawnOllamaCloud({}); } catch (e) { err = e; }
    ok(err, 'expected throw');
    contains(err.message, 'ollama-cloud');
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
