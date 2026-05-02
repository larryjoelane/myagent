// WorkerManager — bridge between IPC handlers and worker channels.
// Owns worker lifecycle (spawn/list/send/close), naming, routing,
// and memory-mirror toggling.
//
// Designed for dependency injection so tests don't have to spin up
// real claude/shell/SQLite:
//
//   factories.claude    : driver factory for headless claude workers
//   factories.shell     : driver factory for shell workers
//   memoryStore         : { store({text, source, tags, ts}) }
//   memoryMirrorDefault : boolean, applies when worker has no override
//
// Each spawned worker is a WorkerChannel wrapping a driver. The
// manager keeps a small registry: { id, kind, name, channel,
// memoryMirror }.

const crypto = require('crypto');
const { WorkerChannel } = require('./workerChannel');

function makeId() { return crypto.randomBytes(6).toString('hex'); }

class WorkerManager {
  constructor({ factories, onEvent, memoryStore, memoryMirrorDefault, contextProvider } = {}) {
    if (!factories || typeof factories.claude !== 'function' || typeof factories.shell !== 'function') {
      throw new Error('WorkerManager: factories.claude and factories.shell are required');
    }
    if (typeof onEvent !== 'function') throw new Error('WorkerManager: onEvent is required');
    this.factories = factories;
    this.onEvent = onEvent;
    this.memoryStore = memoryStore || null;
    this.memoryMirrorDefault = memoryMirrorDefault !== false;
    // Optional async function ({ to, text, workerName, workerKind })
    // → { preamble, usedHits }. When set, called before each send()
    // to compute auto-context. Failure or empty preamble = no
    // injection (send proceeds with original text).
    this.contextProvider = (typeof contextProvider === 'function') ? contextProvider : null;
    this.workers = new Map(); // id -> { id, kind, name, channel, memoryMirror }
    this._workerCounter = 0;
  }

  list() {
    return [...this.workers.values()].map((w) => ({
      id: w.id,
      kind: w.kind,
      name: w.name,
      cwd: w.cwd,
      memoryMirror: w.memoryMirror,
    }));
  }

  async spawnWorker({ name, cwd, permissionMode } = {}) {
    return this._spawn({
      kind: 'claude',
      name: name || this._nextWorkerName(),
      driverOpts: { cwd, permissionMode },
    });
  }

  async spawnShell({ name, cwd } = {}) {
    return this._spawn({
      kind: 'shell',
      name: name || 'shell',
      driverOpts: { cwd },
    });
  }

  send({ to, text }) {
    const target = this._resolve(to);
    if (!target) {
      const available = this.list().map((w) => w.name).join(', ') || '(none)';
      this.onEvent('chat:error', {
        error: `no worker matches "${to}"; available: ${available}`,
      });
      return;
    }
    // Auto-context: if a provider is wired up, ask it for a preamble
    // before sending. Provider runs async; we don't block the
    // response path on it. If it fails or returns empty, the send
    // proceeds with the original text unchanged.
    if (this.contextProvider) {
      this._sendWithContext(target, text);
    } else {
      target.channel.send(text);
    }
  }

  async _sendWithContext(target, text) {
    let augmented = text;
    let usedHits = [];
    try {
      const result = await this.contextProvider({
        to: target.id,
        text,
        workerName: target.name,
        workerKind: target.kind,
      });
      if (result && typeof result.preamble === 'string' && result.preamble.length > 0) {
        augmented = result.preamble + text;
        usedHits = Array.isArray(result.usedHits) ? result.usedHits : [];
      }
    } catch {
      // Provider failure must not block the send. Fall through to the
      // original text so the user gets a response no matter what.
    }
    if (usedHits.length > 0) {
      this.onEvent('chat:context-used', {
        agentId: target.id,
        userText: text,
        usedHits,
      });
    }
    target.channel.send(augmented);
  }

  setMirror({ id, on }) {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: `no worker ${id}` };
    w.memoryMirror = on === null ? null : !!on;
    return { ok: true };
  }

  rename({ id, name }) {
    const w = this.workers.get(id);
    if (!w) throw new Error(`no worker ${id}`);
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('name cannot be empty');
    for (const other of this.workers.values()) {
      if (other.id !== id && other.name === trimmed) {
        throw new Error(`name "${trimmed}" already in use`);
      }
    }
    w.name = trimmed;
    return { ok: true, id, name: trimmed };
  }

  async close(id) {
    const w = this.workers.get(id);
    if (!w) return;
    this.workers.delete(id);
    try { await w.channel.close(); } catch { /* ignore */ }
  }

  async closeAll() {
    const ids = [...this.workers.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  // --- internal -----------------------------------------------------------

  _nextWorkerName() {
    const used = new Set([...this.workers.values()].map((w) => w.name));
    for (let i = 1; i < 1000; i++) {
      const candidate = `Worker ${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `Worker ${Date.now()}`;
  }

  async _spawn({ kind, name, driverOpts }) {
    // Reject duplicate name up front so callers don't get surprises.
    for (const w of this.workers.values()) {
      if (w.name === name) {
        throw new Error(`name "${name}" already in use`);
      }
    }
    const id = makeId();
    const factory = this.factories[kind];
    const channel = new WorkerChannel({
      agentId: id,
      onEvent: (eventName, payload) => this._handleEvent(id, eventName, payload),
      driverFactory: (opts) => factory({ ...opts, ...driverOpts }),
    });
    await channel.start();
    const record = { id, kind, name, cwd: driverOpts.cwd, channel, memoryMirror: null };
    this.workers.set(id, record);
    return { id, name, kind, cwd: driverOpts.cwd };
  }

  _resolve(to) {
    if (!to) return null;
    if (this.workers.has(to)) return this.workers.get(to);
    for (const w of this.workers.values()) {
      if (w.name === to) return w;
    }
    return null;
  }

  _handleEvent(id, eventName, payload) {
    // Forward upward.
    this.onEvent(eventName, payload);
    // Memory mirror on turn-end.
    if (eventName === 'chat:turn-end') {
      this._mirrorTurn(id, payload);
    }
    // Auto-cleanup on driver exit so a crashed worker doesn't linger.
    if (eventName === 'chat:driver-exit') {
      this.workers.delete(id);
    }
  }

  _shouldMirror(id) {
    const w = this.workers.get(id);
    if (!w) return false;
    if (typeof w.memoryMirror === 'boolean') return w.memoryMirror;
    return this.memoryMirrorDefault;
  }

  async _mirrorTurn(id, payload) {
    if (!this.memoryStore) return;
    if (!this._shouldMirror(id)) return;
    const stamp = new Date().toISOString();
    try {
      if (payload.userText && String(payload.userText).trim()) {
        await this.memoryStore.store({
          text: String(payload.userText).trim(),
          source: `chat-user:${id}`,
          tags: ['chat', 'user'],
          ts: stamp,
        });
      }
      if (payload.assistantText && String(payload.assistantText).trim()) {
        await this.memoryStore.store({
          text: String(payload.assistantText).trim(),
          source: `chat-assistant:${id}`,
          tags: ['chat', 'assistant'],
          ts: stamp,
        });
      }
    } catch { /* never let memory write break the chat */ }
  }
}

module.exports = { WorkerManager };
