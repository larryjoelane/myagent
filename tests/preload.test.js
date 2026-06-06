// Bridge tests. The preload sits between the main process and the
// renderer; bugs here are silent because typecheck and main-process
// unit tests both pass while the bridge does nothing. Specifically
// what these tests catch:
//
//   1. A new chat:* event added to a main-process emitter without a
//      matching forwarder in preload-events.js.
//   2. A new ipcMain.handle('foo:bar', ...) registered in
//      electron/ipc/* without a matching ipcRenderer.invoke in the
//      transport surface (or vice versa — orphan calls from preload).
//   3. The forwarder firing without re-emitting through the listener
//      registry, so transport.chat.on subscribers never see anything.
//
// The preload module itself runs `contextBridge.exposeInMainWorld`
// at load time, which only works in a real Electron preload context.
// We set MYAGENT_TEST_PRELOAD_NOINSTALL before requiring it so the
// installer is skipped — tests import the pure functions and drive
// them with fakes.

process.env.MYAGENT_TEST_PRELOAD_NOINSTALL = '1';

const fs = require('fs');
const path = require('path');
const { eq, ok, contains, deepEq } = require('./assert');
// preload.js is the runtime source of truth — its sandbox can't do
// relative requires, so the channel list lives inline there. We
// import it for the actual coverage assertions.
const {
  installEventForwarders,
  buildTransport,
  ALL_FORWARDED_CHANNELS,
} = require('../electron/preload');
// preload-events.js is a documentation/reference module exporting the
// same list grouped by purpose. We assert it stays in sync with the
// runtime list so future readers don't get conflicting answers.
const {
  CHAT_EVENTS,
  AGENT_EVENT_MAP,
  PTY_EVENTS,
  BROWSER_EVENTS,
  MODEL_EVENTS,
  ALL_FORWARDED_CHANNELS: REFERENCE_CHANNELS,
} = require('../electron/preload-events');

// Fake ipcRenderer that records on() registrations and lets tests
// fire incoming events synchronously to exercise the forwarders.
function fakeIpcRenderer() {
  const handlers = new Map(); // channel -> Array<fn>
  const invoked = [];         // [{ channel, args }]
  const sent = [];            // [{ channel, args }]
  return {
    on(channel, fn) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(fn);
    },
    invoke(channel, ...args) {
      invoked.push({ channel, args });
      return Promise.resolve({ ok: true });
    },
    send(channel, ...args) { sent.push({ channel, args }); },
    // Test helper — fire whatever main would have sent. Returns the
    // number of handlers that ran (non-zero confirms registration).
    _fire(channel, msg) {
      const list = handlers.get(channel) || [];
      for (const fn of list) fn({}, msg);
      return list.length;
    },
    _registeredChannels() { return [...handlers.keys()]; },
    _invoked: invoked,
    _sent: sent,
  };
}

function fakeClipboard() {
  let v = '';
  return { readText: () => v, writeText: (s) => { v = s; } };
}

// Walk transport (recursively) and collect every ipcRenderer.invoke /
// .send channel name used. We do this by patching invoke/send on the
// fake to capture channels — we *call* every leaf method to make it
// emit its channel. This catches: a method on transport that invokes
// 'foo:bar' which main never handles.
function collectInvokedChannels(transport) {
  const channels = new Set();
  /** @param {any} node */
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === 'function') {
        // Call with a sensible argument shape — most transport methods
        // accept (idOrPath, opts) or (body) and the fake invoke
        // captures the channel regardless of args.
        try { v('test', { test: true }); } catch { /* ignore — we only care about channels */ }
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  }
  walk(transport);
  return channels;
}

// Read every ipcMain.handle('x:y', ...) registered under electron/ipc/.
// Static parse — good enough because the codebase uses literal strings
// for channel names and the test runs against the source files.
function readMainHandlerChannels() {
  const dir = path.join(__dirname, '..', 'electron', 'ipc');
  const channels = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // Match ipcMain.handle('channel', ...) and ipcMain.on('channel', ...)
    const re = /ipcMain\s*\.\s*(?:handle|on)\s*\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) channels.add(m[1]);
  }
  return channels;
}

// Read every chat:* event the WorkerManager broadcasts. These MUST be
// in CHAT_EVENTS or the renderer never receives them.
function readChatEventsEmittedByManager() {
  const file = path.join(__dirname, '..', 'src', 'core', 'workerManager.js');
  const src = fs.readFileSync(file, 'utf8');
  const events = new Set();
  // Patterns observed in the file:
  //   this.onEvent('chat:foo', ...)
  //   this.onEvent(eventName, ...) — dynamic, not enumerable, so we
  //   just collect the literal-string call sites.
  const re = /onEvent\s*\(\s*['"](chat:[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) events.add(m[1]);
  return events;
}

// Same for WorkerChannel — it emits chat:driver-exit etc.
function readChatEventsEmittedByChannel() {
  const file = path.join(__dirname, '..', 'src', 'core', 'workerChannel.js');
  const src = fs.readFileSync(file, 'utf8');
  const events = new Set();
  const re = /['"](chat:[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) events.add(m[1]);
  return events;
}

// And drivers — each emits its own set.
function readChatEventsEmittedByDrivers() {
  const dir = path.join(__dirname, '..', 'src', 'core', 'drivers');
  const events = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /['"](chat:[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) events.add(m[1]);
  }
  return events;
}

exports.run = (ctx) => {
  // ----- Source-of-truth alignment -------------------------------------

  ctx.test('preload.js inline channel list matches preload-events.js reference list', () => {
    // preload.js inlines the list because Electron's preload sandbox
    // can't resolve relative requires (require('./preload-events') in
    // the preload throws "module not found" at app start). We keep
    // preload-events.js as a documentation/reference module and
    // assert here that the two stay in sync — if you add a channel
    // to one, this test fails until you add it to the other.
    const fromPreload = ALL_FORWARDED_CHANNELS.map((c) => `${c.channel}->${c.emitAs}`).sort();
    const fromReference = REFERENCE_CHANNELS.map((c) => `${c.channel}->${c.emitAs}`).sort();
    deepEq(fromPreload, fromReference,
      'preload.js ALL_FORWARDED_CHANNELS and preload-events.js are out of sync');
  });

  // ----- Forwarder installation ----------------------------------------

  ctx.test('installEventForwarders registers ipcRenderer.on for every canonical channel', () => {
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    installEventForwarders({ ipcRenderer: ipc, listeners });
    const registered = new Set(ipc._registeredChannels());
    for (const { channel } of ALL_FORWARDED_CHANNELS) {
      ok(registered.has(channel), `expected ipcRenderer.on('${channel}') to be installed`);
    }
  });

  ctx.test('forwarder re-emits each event through the listener registry under emitAs', () => {
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    installEventForwarders({ ipcRenderer: ipc, listeners });
    for (const { channel, emitAs } of ALL_FORWARDED_CHANNELS) {
      const received = [];
      if (!listeners.has(emitAs)) listeners.set(emitAs, new Set());
      listeners.get(emitAs).add((m) => received.push(m));
      const fired = ipc._fire(channel, { hello: channel });
      ok(fired > 0, `expected at least one handler for ${channel}`);
      eq(received.length, 1, `expected ${channel} → ${emitAs} to deliver one msg`);
      deepEq(received[0], { hello: channel });
    }
  });

  ctx.test('agent:* legacy events get aliased correctly', () => {
    // The renderer subscribes by short name ('chunk', 'done', ...) but
    // main sends on the prefixed channel. The alias map is the bridge.
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    installEventForwarders({ ipcRenderer: ipc, listeners });
    for (const [channel, emitAs] of Object.entries(AGENT_EVENT_MAP)) {
      const received = [];
      listeners.set(emitAs, new Set([(m) => received.push(m)]));
      ipc._fire(channel, { id: 'x' });
      eq(received.length, 1, `${channel} should re-emit as ${emitAs}`);
    }
  });

  // ----- Coverage of main-process emitters -----------------------------

  ctx.test('every chat:* event WorkerManager emits is in CHAT_EVENTS', () => {
    const emitted = readChatEventsEmittedByManager();
    const covered = new Set(CHAT_EVENTS);
    const missing = [...emitted].filter((e) => !covered.has(e));
    eq(missing.length, 0,
      `WorkerManager emits chat events not in CHAT_EVENTS: ${missing.join(', ')}\n` +
      `  Add them to electron/preload-events.js so the renderer actually receives them.`);
  });

  ctx.test('every chat:* event WorkerChannel emits is in CHAT_EVENTS', () => {
    const emitted = readChatEventsEmittedByChannel();
    const covered = new Set(CHAT_EVENTS);
    const missing = [...emitted].filter((e) => !covered.has(e));
    eq(missing.length, 0,
      `WorkerChannel emits chat events not in CHAT_EVENTS: ${missing.join(', ')}`);
  });

  ctx.test('every chat:* event the drivers emit is in CHAT_EVENTS', () => {
    const emitted = readChatEventsEmittedByDrivers();
    const covered = new Set(CHAT_EVENTS);
    const missing = [...emitted].filter((e) => !covered.has(e));
    eq(missing.length, 0,
      `A driver emits chat events not in CHAT_EVENTS: ${missing.join(', ')}\n` +
      `  Add them to electron/preload-events.js or remove the emit.`);
  });

  // ----- Transport ↔ main handler pairing ------------------------------

  ctx.test('every ipcRenderer.invoke channel in transport has a matching ipcMain.handle in electron/ipc', () => {
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    const transport = buildTransport({ ipcRenderer: ipc, clipboard: fakeClipboard(), listeners });
    collectInvokedChannels(transport); // populates ipc._invoked + _sent
    const invoked = new Set(ipc._invoked.map((r) => r.channel));
    const sent = new Set(ipc._sent.map((r) => r.channel));
    const main = readMainHandlerChannels();

    // Some send() channels are handled in main via ipcMain.on (e.g. pty input,
    // browser:set-bounds, agent:run). Our regex catches both .handle and .on
    // already, so a missing handler shows up the same way.
    const missing = [];
    for (const ch of [...invoked, ...sent]) {
      // Skip channels whose handlers live OUTSIDE electron/ipc (e.g. pty
      // and browser register handlers from electron/main.js or via
      // dedicated modules). We document the known exceptions inline so
      // this test fails loudly if a NEW orphan appears.
      if (KNOWN_NON_IPC_HANDLERS.has(ch)) continue;
      if (!main.has(ch)) missing.push(ch);
    }
    eq(missing.length, 0,
      `transport invokes channel(s) with no matching ipcMain.handle in electron/ipc: ${missing.join(', ')}\n` +
      `  Either register a handler, remove the transport method, or add the channel to KNOWN_NON_IPC_HANDLERS in tests/preload.test.js with a comment explaining where it IS handled.`);
  });

  ctx.test('no ipcMain.handle channel in electron/ipc is unreachable from transport', () => {
    // The other direction: a handler with no caller is dead code at best,
    // a coverage hole at worst. We don't fail on extras here because some
    // handlers are called by main itself (loopback test paths) — but we
    // print them so a reviewer notices.
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    const transport = buildTransport({ ipcRenderer: ipc, clipboard: fakeClipboard(), listeners });
    collectInvokedChannels(transport);
    const reachable = new Set([
      ...ipc._invoked.map((r) => r.channel),
      ...ipc._sent.map((r) => r.channel),
    ]);
    const main = readMainHandlerChannels();
    const orphans = [...main].filter((ch) => !reachable.has(ch));
    // Soft assertion via console for now — flips to hard failure once
    // the codebase is clean. Today's known-orphan list is documented
    // in the test file alongside KNOWN_NON_IPC_HANDLERS.
    if (orphans.length > 0) {
      // Acceptable orphans — handlers reachable through some other path.
      const acceptable = new Set(KNOWN_ORPHAN_HANDLERS);
      const surprising = orphans.filter((ch) => !acceptable.has(ch));
      eq(surprising.length, 0,
        `unexpected ipcMain handler with no transport caller: ${surprising.join(', ')}\n` +
        `  Add to KNOWN_ORPHAN_HANDLERS with a comment if intentional.`);
    }
  });

  // ----- Subscribe round-trip ------------------------------------------

  ctx.test('transport.chat.on(name, fn) receives forwarded events', () => {
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    installEventForwarders({ ipcRenderer: ipc, listeners });
    const transport = buildTransport({ ipcRenderer: ipc, clipboard: fakeClipboard(), listeners });
    const got = [];
    transport.chat.on('chat:context-used', (m) => got.push(m));
    ipc._fire('chat:context-used', { agentId: 'a', usedHits: [{ id: 1 }] });
    eq(got.length, 1);
    deepEq(got[0], { agentId: 'a', usedHits: [{ id: 1 }] });
  });

  ctx.test('subscribe returns an unsubscribe function that detaches the listener', () => {
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    installEventForwarders({ ipcRenderer: ipc, listeners });
    const transport = buildTransport({ ipcRenderer: ipc, clipboard: fakeClipboard(), listeners });
    const got = [];
    const off = transport.chat.on('chat:user', (m) => got.push(m));
    ipc._fire('chat:user', { text: 'a' });
    off();
    ipc._fire('chat:user', { text: 'b' });
    eq(got.length, 1, 'after off() further events should not arrive');
  });

  ctx.test('transport.pty.onData / onExit subscribe to pty channels', () => {
    const ipc = fakeIpcRenderer();
    const listeners = new Map();
    installEventForwarders({ ipcRenderer: ipc, listeners });
    const transport = buildTransport({ ipcRenderer: ipc, clipboard: fakeClipboard(), listeners });
    const data = []; const exits = [];
    transport.pty.onData((m) => data.push(m));
    transport.pty.onExit((m) => exits.push(m));
    ipc._fire('pty:data', { paneId: 1, chunk: 'x' });
    ipc._fire('pty:exit', { paneId: 1, code: 0 });
    eq(data.length, 1);
    eq(exits.length, 1);
  });

  // ----- Sandbox-relative-require regression guard ---------------------
  // Electron's preload sandbox can't resolve relative requires
  // (require('./foo')). A previous refactor extracted the channel
  // list to ./preload-events.js and the preload imported it — works
  // in tests, fails at app start with "module not found". This test
  // statically scans preload.js for any relative require that would
  // trip the sandbox.
  ctx.test('preload.js makes no relative requires (Electron sandbox restriction)', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    // Strip /* … */ block comments and // line comments so a comment
    // mentioning a relative require (e.g. in the explanatory header)
    // doesn't trip the scanner. Naive but correct for this codebase
    // where strings don't contain `*/` or unescaped `//` sequences.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const re = /require\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
    const offenders = [];
    let m;
    while ((m = re.exec(src)) !== null) offenders.push(m[1]);
    eq(offenders.length, 0,
      `preload.js requires relative module(s) ${offenders.join(', ')} — Electron's sandbox preloadRequire cannot resolve these. Inline the dependency or move the code so it doesn't need a relative require.`);
  });
};

// Channels invoked from the preload that are NOT registered in
// electron/ipc/*.js. Document each with a one-line reason. If a new
// orphan appears, prefer registering a handler over adding to this list.
const KNOWN_NON_IPC_HANDLERS = new Set([
  // model:reply, model:chunk, model:ready, model:log — handled by
  // EmbedderBridge (src/core/embedderBridge.js) which registers ipcMain.on
  // directly because the bridge owns the model-worker conversation lifecycle.
  // Not in electron/ipc/ because the bridge is constructed from
  // electron/main.js as a peer, not as a handler module.
  'model:reply',
  'model:chunk',
  'model:ready',
  'model:log',
]);

// Channels handled by ipcMain but not invoked from the renderer transport.
// Used for the soft "unreachable handler" check.
const KNOWN_ORPHAN_HANDLERS = new Set([
  // (none today.)
]);
