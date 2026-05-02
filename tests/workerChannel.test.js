// WorkerChannel tests for the driver-based architecture.
//
// The channel is a thin adapter: it wraps a driver, exposes a clean
// API to main.js, and lets driver events flow through. These tests
// don't care about what kind of driver is wrapped — claude, shell, or
// a fake. The channel must work the same way either way.
//
// We use a minimal fake driver that exposes the contract the channel
// depends on:
//   start() / close() / send(text), emits chat:* events via onEvent.

const { WorkerChannel } = require('../src/core/workerChannel');
const { eq, ok, contains, eventually } = require('./assert');

// Minimal fake driver. Production code never uses this — it's a
// stand-in for ClaudeDriver / ShellDriver during tests.
class FakeDriver {
  constructor({ agentId, onEvent }) {
    this.agentId = agentId;
    this.onEvent = onEvent;
    this.started = false;
    this.closed = false;
    this.sent = [];
    // Allow tests to script the response sequence to each send().
    this.responder = null;
  }
  async start() { this.started = true; }
  async close() { this.closed = true; }
  send(text) {
    this.sent.push(text);
    if (typeof this.responder === 'function') {
      this.responder(text, this);
    }
  }
  // Helpers tests use to script driver behavior.
  emit(name, payload = {}) {
    this.onEvent(name, { agentId: this.agentId, ...payload });
  }
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

function run(t) {

  t.test('start() initializes the wrapped driver', async () => {
    const r = recorder();
    let captured = null;
    const channel = new WorkerChannel({
      agentId: 'a1',
      onEvent: r.onEvent,
      driverFactory: ({ agentId, onEvent }) => {
        captured = new FakeDriver({ agentId, onEvent });
        return captured;
      },
    });
    await channel.start();
    ok(captured, 'driver was created');
    eq(captured.started, true, 'driver.start() was called');
    eq(captured.agentId, 'a1', 'driver received agentId');
  });

  t.test('send(text) forwards to driver.send()', async () => {
    const r = recorder();
    let driver;
    const channel = new WorkerChannel({
      agentId: 'a2',
      onEvent: r.onEvent,
      driverFactory: (opts) => (driver = new FakeDriver(opts)),
    });
    await channel.start();
    channel.send('hello');
    eq(driver.sent.length, 1, 'driver received one send');
    eq(driver.sent[0], 'hello', 'driver received exact text');
  });

  t.test('driver events flow through to channel.onEvent', async () => {
    const r = recorder();
    let driver;
    const channel = new WorkerChannel({
      agentId: 'a3',
      onEvent: r.onEvent,
      driverFactory: (opts) => (driver = new FakeDriver(opts)),
    });
    await channel.start();
    driver.emit('chat:user', { text: 'hi' });
    driver.emit('chat:turn-start');
    driver.emit('chat:chunk', { kind: 'text', text: 'response' });
    driver.emit('chat:turn-end', { userText: 'hi', assistantText: 'response', ok: true });
    eq(r.countOf('chat:user'), 1);
    eq(r.countOf('chat:turn-start'), 1);
    eq(r.countOf('chat:chunk'), 1);
    eq(r.countOf('chat:turn-end'), 1);
    eq(r.last('chat:user').payload.text, 'hi', 'payload preserved');
  });

  t.test('events from driver carry the channel agentId', async () => {
    const r = recorder();
    let driver;
    const channel = new WorkerChannel({
      agentId: 'a4',
      onEvent: r.onEvent,
      driverFactory: (opts) => (driver = new FakeDriver(opts)),
    });
    await channel.start();
    driver.emit('chat:user', { text: 'x' });
    eq(r.last('chat:user').payload.agentId, 'a4', 'agentId tagged on event');
  });

  t.test('close() shuts down the driver', async () => {
    let driver;
    const channel = new WorkerChannel({
      agentId: 'a5',
      onEvent: () => {},
      driverFactory: (opts) => (driver = new FakeDriver(opts)),
    });
    await channel.start();
    await channel.close();
    eq(driver.closed, true, 'driver.close() was called');
  });

  t.test('send() before start() does not crash', async () => {
    const r = recorder();
    const channel = new WorkerChannel({
      agentId: 'a6',
      onEvent: r.onEvent,
      driverFactory: (opts) => new FakeDriver(opts),
    });
    // Don't call start(). send() should error gracefully.
    channel.send('early');
    const err = r.last('chat:error');
    ok(err, 'chat:error emitted');
    contains(err.payload.error, 'not started');
  });

  t.test('send() after close() does not crash', async () => {
    const r = recorder();
    const channel = new WorkerChannel({
      agentId: 'a7',
      onEvent: r.onEvent,
      driverFactory: (opts) => new FakeDriver(opts),
    });
    await channel.start();
    await channel.close();
    channel.send('late');
    const err = r.last('chat:error');
    ok(err, 'chat:error emitted');
    contains(err.payload.error, 'closed');
  });

  t.test('channel works identically with two different driver factories', async () => {
    // Validates the abstraction — the channel doesn't care about
    // driver type. Same test against two minimally-different fakes.
    for (const variant of ['variant-a', 'variant-b']) {
      const r = recorder();
      let driver;
      const channel = new WorkerChannel({
        agentId: variant,
        onEvent: r.onEvent,
        driverFactory: (opts) => {
          driver = new FakeDriver(opts);
          driver.variant = variant; // proves the factory was actually used
          return driver;
        },
      });
      await channel.start();
      channel.send('test');
      driver.emit('chat:turn-end', { userText: 'test', assistantText: 'done', ok: true });
      eq(driver.variant, variant, 'right factory used');
      eq(r.countOf('chat:turn-end'), 1, 'event flowed through');
    }
  });

  t.test('chat:driver-exit propagates and channel auto-closes', async () => {
    // When the driver exits unexpectedly (claude crash, shell killed),
    // the channel should pass the event through and mark itself closed
    // so subsequent sends fail cleanly rather than wedging.
    const r = recorder();
    let driver;
    const channel = new WorkerChannel({
      agentId: 'a8',
      onEvent: r.onEvent,
      driverFactory: (opts) => (driver = new FakeDriver(opts)),
    });
    await channel.start();
    driver.emit('chat:driver-exit', { code: 1, signal: null });
    eq(r.countOf('chat:driver-exit'), 1);
    // After exit, send should error.
    channel.send('after exit');
    ok(r.last('chat:error'), 'send after driver-exit errors');
  });
}

module.exports = { run };
