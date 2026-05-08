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

function shortModelHint(model) {
  if (!model || typeof model !== 'string') return '';
  // "ibm/granite-docling" -> "granite-docling"; "gpt-oss:120b-cloud" -> "gpt-oss"
  const afterSlash = model.includes('/') ? model.split('/').pop() : model;
  return afterSlash.split(':')[0] || '';
}

class WorkerManager {
  constructor({ factories, onEvent, memoryStore, memoryMirrorDefault, contextProvider } = {}) {
    if (!factories || typeof factories.claude !== 'function' || typeof factories.shell !== 'function') {
      throw new Error('WorkerManager: factories.claude and factories.shell are required');
    }
    // Other factories (semantic, future agent types) are optional —
    // spawnX() methods check before calling and return a clean error
    // if the kind isn't registered.
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
    // Per-worker original user text for the in-flight turn. Populated
    // when auto-context augments the prompt; consulted in _handleEvent
    // so chat:user (UI bubble) and chat:turn-end.userText (memory mirror)
    // both reflect what the USER typed, not the augmented prompt the
    // driver sees. Cleared on turn-end. Without this, the augmented
    // text gets mirrored to memory, then retrieved on the next turn,
    // then augmented again — a recursive preamble loop the user sees
    // as growing duplicated context in their bubbles.
    /** @type {Map<string, string>} */
    this._pendingOriginalUserText = new Map();
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

  async spawnSemantic({ name, cwd } = {}) {
    if (typeof this.factories.semantic !== 'function') {
      throw new Error('semantic agent type is not available (no factories.semantic)');
    }
    return this._spawn({
      kind: 'semantic',
      name: name || this._nextSemanticName(),
      driverOpts: { cwd },
    });
  }

  async spawnOllamaCloud({ name, cwd, model } = {}) {
    if (typeof this.factories['ollama-cloud'] !== 'function') {
      throw new Error('ollama-cloud agent type is not available (no factories[\'ollama-cloud\'])');
    }
    return this._spawn({
      kind: 'ollama-cloud',
      name: name || this._nextOllamaCloudName(model),
      driverOpts: { cwd, model },
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
    //
    // Two cases skip auto-context entirely:
    //   - Slash commands (`/cmd ...`): explicit user intent. Prepending
    //     a "relevant past context" preamble would disqualify the
    //     slash parser (which requires `^/`) AND pollute the input the
    //     tool sees. The user typed a command; honor it verbatim.
    //   - Semantic workers: they route by literal cosine similarity
    //     between the user's prompt and tool descriptions. A preamble
    //     full of prior chat noise wrecks the routing. Auto-context is
    //     designed for Claude-style generative workers.
    const isSlash = /^\s*\/[a-z]/i.test(text);
    const skipAutoContext = isSlash || target.kind === 'semantic';
    if (this.contextProvider && !skipAutoContext) {
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
    // Stash the original so _handleEvent can rewrite chat:user and
    // chat:turn-end.userText back to it before forwarding/mirroring.
    // Only stash when augmentation actually changed the text — saves
    // a Map entry on the no-hit path.
    if (augmented !== text) {
      this._pendingOriginalUserText.set(target.id, text);
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

  // Surface a worker's tool list when the driver has one (currently
  // only SemanticDriver). Returns null for kinds that don't expose
  // tools, so the renderer can decide whether to show autocomplete.
  // Each entry: { id, name, description, usage? }
  listTools(id) {
    const w = this.workers.get(id);
    if (!w) return null;
    const driver = w.channel?.driver;
    const kit = driver?.toolkit;
    if (!kit || typeof kit.list !== 'function') return null;
    return kit.list().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
      usage: Array.isArray(t.usage) ? t.usage : [],
    }));
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

  _nextSemanticName() {
    const used = new Set([...this.workers.values()].map((w) => w.name));
    for (let i = 1; i < 1000; i++) {
      const candidate = `Semantic ${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `Semantic ${Date.now()}`;
  }

  _nextOllamaCloudName(model) {
    // Use the short model tag (text after last `/` or `:`) as a name
    // hint when the caller picked a model — makes it easy to tell
    // "Ollama gpt-oss" apart from "Ollama granite-docling" in the list.
    const used = new Set([...this.workers.values()].map((w) => w.name));
    const hint = shortModelHint(model);
    const base = hint ? `Ollama ${hint}` : 'Ollama';
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 && hint ? base : `${base} ${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  async _spawn({ kind, name, driverOpts, record: extra }) {
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
    const record = { id, kind, name, cwd: driverOpts.cwd, channel, memoryMirror: null, ...(extra || {}) };
    this.workers.set(id, record);
    return { id, name, kind, cwd: driverOpts.cwd, ...(extra || {}) };
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
    // Rewrite augmented user text back to the original before anything
    // downstream sees it. Drivers receive the augmented prompt (preamble
    // + text) and naturally echo that on chat:user / chat:turn-end —
    // but the UI must show what the USER typed, and the memory mirror
    // must store the original (otherwise the next turn retrieves the
    // augmented version, augments it again, and we get a recursive
    // preamble loop visible in the chat bubbles).
    let outgoing = payload;
    const original = this._pendingOriginalUserText.get(id);
    if (original !== undefined) {
      if (eventName === 'chat:user' && payload && typeof payload.text === 'string') {
        outgoing = { ...payload, text: original };
      } else if (eventName === 'chat:turn-end' && payload && typeof payload.userText === 'string') {
        outgoing = { ...payload, userText: original };
      }
    }
    // Forward upward.
    this.onEvent(eventName, outgoing);
    // Memory mirror on turn-end. Use the rewritten payload so the
    // mirror writes the ORIGINAL user text, not the augmented one.
    if (eventName === 'chat:turn-end') {
      this._mirrorTurn(id, outgoing);
      // Turn is over; clear the stash so the next turn starts clean.
      this._pendingOriginalUserText.delete(id);
    }
    // Auto-cleanup on driver exit so a crashed worker doesn't linger.
    if (eventName === 'chat:driver-exit') {
      this.workers.delete(id);
      this._pendingOriginalUserText.delete(id);
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
