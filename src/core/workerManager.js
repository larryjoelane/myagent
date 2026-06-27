// WorkerManager — bridge between IPC handlers and worker channels.
// Owns worker lifecycle (spawn/list/send/close), naming, routing,
// and memory-mirror toggling.
//
// Designed for dependency injection so tests don't have to spin up
// real model/shell/SQLite:
//
//   factories.shell     : driver factory for shell workers
//   factories.openrouter / 'ollama-cloud' / local : model worker factories
//   memoryStore         : { store({text, source, tags, ts}) }
//   memoryMirrorDefault : boolean, applies when worker has no override
//
// Each spawned worker is a WorkerChannel wrapping a driver. The
// manager keeps a small registry: { id, kind, name, channel,
// memoryMirror }.

const crypto = require('crypto');
const { WorkerChannel } = require('./workerChannel');
const { Scope } = require('./scope');
const { isAutoContextExcluded } = require('./autoContextExclusions');

function makeId() { return crypto.randomBytes(6).toString('hex'); }

// Platform-aware path equality. Windows is case-insensitive but
// case-preserving — `C:\Users\Foo` and `c:\users\foo` are the same.
// Used to refuse Scope-removal of the cwd fence.
function samePath(a, b) {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function shortModelHint(model) {
  if (!model || typeof model !== 'string') return '';
  // "ibm/granite-docling" -> "granite-docling"; "gpt-oss:120b-cloud" -> "gpt-oss"
  const afterSlash = model.includes('/') ? model.split('/').pop() : model;
  return afterSlash.split(':')[0] || '';
}

class WorkerManager {
  constructor({ factories, onEvent, memoryStore, memoryMirrorDefault, contextProvider, editorScope } = {}) {
    if (!factories || typeof factories.shell !== 'function') {
      throw new Error('WorkerManager: factories.shell is required');
    }
    // Other factories (ollama-cloud, openrouter, local, future agent types)
    // are optional — spawnX() methods check before calling and return a clean
    // error if the kind isn't registered.
    if (typeof onEvent !== 'function') throw new Error('WorkerManager: onEvent is required');
    this.factories = factories;
    this.onEvent = onEvent;
    this.memoryStore = memoryStore || null;
    this.memoryMirrorDefault = memoryMirrorDefault !== false;
    // Optional reference to the editor's global scope (a Scope
    // instance). When set, spawn-time per-worker scopes seed
    // themselves with [cwd, ...editorScope.list()] so tool-use
    // drivers can read the files the user has open.
    // Held as a reference, not a snapshot — but per-worker scopes
    // ARE snapshots (we don't propagate later editor mutations into
    // already-running workers; the user manages each worker's scope
    // independently after spawn).
    this.editorScope = editorScope || null;
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
      // Scope roots — flat array of absolute paths. Inert for
      // claude/shell (the toolkit doesn't run for those drivers),
      // but the UI surfaces it uniformly so users can see what each
      // worker is allowed to read.
      scopeRoots: w.scope ? w.scope.list() : [],
    }));
  }

  // Generic "spawn the default worker". Defaults to openrouter now that the
  // claude (Claude Code CLI) driver has been removed. `permissionMode` is
  // accepted for backward compatibility but ignored (it was claude-specific).
  async spawnWorker({ name, cwd, model, maxIterations, envContext, parallelDispatch } = {}) {
    return this.spawnOpenRouter({ name, cwd, model, maxIterations, envContext, parallelDispatch });
  }

  async spawnShell({ name, cwd } = {}) {
    return this._spawn({
      kind: 'shell',
      name: name || 'shell',
      driverOpts: { cwd },
    });
  }

  async spawnOllamaCloud({ name, cwd, model, maxIterations, envContext, parallelDispatch } = {}) {
    if (typeof this.factories['ollama-cloud'] !== 'function') {
      throw new Error('ollama-cloud agent type is not available (no factories[\'ollama-cloud\'])');
    }
    return this._spawn({
      kind: 'ollama-cloud',
      name: name || this._nextProviderName('Ollama', model),
      driverOpts: { cwd, model, maxIterations, envContext, parallelDispatch },
    });
  }

  async spawnOpenRouter({ name, cwd, model, maxIterations, envContext, parallelDispatch } = {}) {
    if (typeof this.factories.openrouter !== 'function') {
      throw new Error('openrouter agent type is not available (no factories.openrouter)');
    }
    return this._spawn({
      kind: 'openrouter',
      name: name || this._nextProviderName('OpenRouter', model),
      driverOpts: { cwd, model, maxIterations, envContext, parallelDispatch },
    });
  }

  // Local in-process text model (ONNX via the model worker) that drives tools
  // by parsed text commands — for no/low-GPU users. model is optional
  // (defaults to the smallest registered generate model in the driver).
  async spawnLocal({ name, cwd, model } = {}) {
    if (typeof this.factories.local !== 'function') {
      throw new Error('local agent type is not available (no factories.local)');
    }
    return this._spawn({
      kind: 'local',
      name: name || this._nextProviderName('Local', model),
      driverOpts: { cwd, model },
    });
  }

  // One-shot Fly.io deploy worker. Each send() deploys the sample webapp
  // image to a fresh Fly Machine under the given (or default) app name and
  // reports back the reachable URL. No cwd — Fly deploys aren't tied to a
  // local directory.
  async spawnFly({ name, appName } = {}) {
    if (typeof this.factories.fly !== 'function') {
      throw new Error('fly agent type is not available (no factories.fly)');
    }
    return this._spawn({
      kind: 'fly',
      name: name || this._nextProviderName('Fly'),
      driverOpts: { appName },
    });
  }

  send({ to, text, originalText }) {
    const target = this._resolve(to);
    if (!target) {
      const available = this.list().map((w) => w.name).join(', ') || '(none)';
      this.onEvent('chat:error', {
        error: `no worker matches "${to}"; available: ${available}`,
      });
      return;
    }
    // Caller-supplied augmentation: when `originalText` is provided
    // and differs from `text`, the renderer has already prepended a
    // preamble (today: explicit /attach files). We still want chat:user
    // and chat:turn-end.userText to reflect what the user actually
    // typed, so stash the original for _handleEvent to swap in before
    // forwarding. This bypasses the contextProvider — caller-driven
    // augmentation is mutually exclusive with auto-context.
    if (typeof originalText === 'string' && originalText !== text) {
      this._pendingOriginalUserText.set(target.id, originalText);
      target.channel.send(text);
      return;
    }
    // Auto-context: if a provider is wired up, ask it for a preamble
    // before sending. Provider runs async; we don't block the
    // response path on it. If it fails or returns empty, the send
    // proceeds with the original text unchanged.
    //
    // Slash commands (`/cmd ...`) skip auto-context: explicit user intent.
    // Prepending a "relevant past context" preamble would disqualify the
    // slash parser (which requires `^/`) AND pollute the input the tool
    // sees. The user typed a command; honor it verbatim.
    //
    // Some worker kinds skip auto-context too — see autoContextExclusions.js
    // (e.g. fly: the chat box there is log output / skill invocation, and
    // `text` is a Fly app name or machine id, not a prompt — a prepended
    // memory/file preamble would corrupt that value before it ever reaches
    // FlyDeployDriver).
    const isSlash = /^\s*\/[a-z]/i.test(text);
    const skipAutoContext = isSlash || isAutoContextExcluded(target.kind);
    if (this.contextProvider && !skipAutoContext) {
      this._sendWithContext(target, text);
    } else {
      target.channel.send(text);
    }
  }

  async _sendWithContext(target, text) {
    let augmented = text;
    let usedHits = [];
    let fileSource = null;
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
        if (result.fileSource && typeof result.fileSource === 'object' && result.fileSource.path) {
          fileSource = {
            path: String(result.fileSource.path),
            dirty: !!result.fileSource.dirty,
          };
        }
      }
    } catch {
      // Provider failure must not block the send. Fall through to the
      // original text so the user gets a response no matter what.
    }
    if (usedHits.length > 0 || fileSource) {
      this.onEvent('chat:context-used', {
        agentId: target.id,
        userText: text,
        usedHits,
        fileSource,
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

  // --- Per-worker scope (ADR-0008) ---------------------------------------
  // The scope is a live reference held on the worker record. Tools
  // dispatched by this worker's driver consult it before fs.* calls.
  // The cwd row is non-removable — that's the spawn-time fence.

  listScope({ id } = {}) {
    const w = this.workers.get(id);
    if (!w || !w.scope) return { ok: false, error: `no worker ${id}` };
    return {
      ok: true,
      cwd: w.cwd || '',
      roots: w.scope.list(),
    };
  }

  async addScope({ id, path } = {}) {
    const w = this.workers.get(id);
    if (!w || !w.scope) return { ok: false, error: `no worker ${id}` };
    if (!path || typeof path !== 'string') {
      return { ok: false, error: 'path is required' };
    }
    try {
      const root = await w.scope.add(path);
      return { ok: true, root, roots: w.scope.list() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async removeScope({ id, path } = {}) {
    const w = this.workers.get(id);
    if (!w || !w.scope) return { ok: false, error: `no worker ${id}` };
    if (!path || typeof path !== 'string') {
      return { ok: false, error: 'path is required' };
    }
    // Refuse to remove the cwd: that's the spawn-time fence.
    // Resolve both sides so case differences on Windows don't matter.
    const path0 = require('path');
    const target = path0.resolve(path);
    const cwd = w.cwd ? path0.resolve(w.cwd) : '';
    if (cwd && samePath(target, cwd)) {
      return { ok: false, error: 'cannot remove the cwd; it is the spawn-time scope fence' };
    }
    const removed = await w.scope.remove(path);
    return { ok: true, removed, roots: w.scope.list() };
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

  // Surface a worker's tool list when the driver exposes a `toolkit`
  // with a list(). Returns null for drivers that don't, so the renderer
  // can decide whether to show slash autocomplete.
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

  // Surfaces a fly worker's last successful deploy ({ appName, machineId,
  // url, syncAgentAddr }) so the /fly-push command knows where to sync
  // files. Returns null for non-fly workers or a fly worker that hasn't
  // deployed yet.
  getFlyDeployInfo(id) {
    const w = this.workers.get(id);
    if (!w || w.kind !== 'fly') return null;
    const driver = w.channel?.driver;
    return driver?.lastDeploy || null;
  }

  // Attaches a fly worker to an already-existing machine (picked from the
  // settings-drawer dropdown) instead of creating one via send(). Uses the
  // driver's defaultAppName (the app name it was spawned with) since the
  // machine already belongs to that app. machineId defaults to the
  // worker's own lastDeploy machine — this is also the "restart sync" path:
  // attachToSyncMachine is idempotent (health-checks before injecting), so
  // calling this again on a worker that's already attached just confirms or
  // revives the sync agent, no machineId lookup required from the caller.
  async attachFly(id, machineId) {
    const w = this.workers.get(id);
    if (!w || w.kind !== 'fly') return { ok: false, error: `no fly worker ${id}` };
    const driver = w.channel?.driver;
    if (!driver || typeof driver.attach !== 'function') {
      return { ok: false, error: 'fly worker has no attach support' };
    }
    if (!driver.defaultAppName) {
      return { ok: false, error: 'no Fly app name set for this worker' };
    }
    const targetMachineId = machineId || driver.lastDeploy?.machineId;
    if (!targetMachineId) {
      return { ok: false, error: 'no machine id — pick one to attach to first' };
    }
    await driver.attach(driver.defaultAppName, targetMachineId);
    return { ok: true };
  }

  // Pure status read for a fly worker's sync agent — no side effects.
  // Returns { ok: false, error } for a non-fly worker or one that hasn't
  // deployed/attached yet; otherwise { ok: true, running, machineState }.
  async checkFlySync(id) {
    const w = this.workers.get(id);
    if (!w || w.kind !== 'fly') return { ok: false, error: `no fly worker ${id}` };
    const driver = w.channel?.driver;
    if (!driver || typeof driver.checkSync !== 'function') {
      return { ok: false, error: 'fly worker has no status check support' };
    }
    return driver.checkSync();
  }

  cancel(id) {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: `no worker ${id}` };
    const cancelled = w.channel.cancel();
    return { ok: true, cancelled };
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

  // Unique worker name from a provider prefix + optional model hint. Use
  // the short model tag (text after last `/` or `:`) as a hint when the
  // caller picked a model — makes it easy to tell "Ollama gpt-oss" apart
  // from "Ollama granite-docling", or "OpenRouter sonnet" from another,
  // in the worker list. Shared by spawnOllamaCloud and spawnOpenRouter.
  // (Distinct from _nextWorkerName(), the no-arg "Worker N" generator for
  // the default claude worker.)
  _nextProviderName(prefix, model) {
    const used = new Set([...this.workers.values()].map((w) => w.name));
    const hint = shortModelHint(model);
    const base = hint ? `${prefix} ${hint}` : prefix;
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
    // Per-worker scope (ADR-0008). Seeded with [cwd, ...editorRoots].
    // Live reference: callers can mutate via addScope/removeScope and
    // the toolkit's filesystem checks see the new state without a
    // respawn. Inert for claude/shell — they don't consult the scope.
    const seed = [];
    if (driverOpts.cwd) seed.push(driverOpts.cwd);
    if (this.editorScope && typeof this.editorScope.list === 'function') {
      for (const r of this.editorScope.list()) seed.push(r);
    }
    const scope = new Scope(seed);
    const factory = this.factories[kind];
    const channel = new WorkerChannel({
      agentId: id,
      onEvent: (eventName, payload) => this._handleEvent(id, eventName, payload),
      // Thread `scope` into the factory so tool-using drivers can
      // hand it to their toolkit. Drivers that don't consume it
      // (claude/shell) ignore the prop harmlessly.
      driverFactory: (opts) => factory({ ...opts, ...driverOpts, scope }),
    });
    await channel.start();
    const record = { id, kind, name, cwd: driverOpts.cwd, channel, scope, memoryMirror: null, ...(extra || {}) };
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
    if (!this.memoryStore || typeof this.memoryStore.storeTurn !== 'function') return;
    if (!this._shouldMirror(id)) return;
    const userText = payload.userText ? String(payload.userText).trim() : '';
    const assistantText = payload.assistantText ? String(payload.assistantText).trim() : '';
    // Nothing worth storing — skip (e.g. an empty/aborted turn).
    if (!userText && !assistantText) return;
    // Store the turn as ONE MySecondBrain row holding the full Q+A pair, so a
    // search hit recalls the whole exchange. This replaces the old
    // two-unlinked-rows mirror (prompt and answer were separate rows in the
    // `rows` table with nothing tying them together). prompt/answer are
    // discrete columns; metadata (provider/model/tokens) rides along.
    const w = this.workers.get(id);
    const totals = payload.totals || {};
    try {
      await this.memoryStore.storeTurn({
        prompt: userText,
        answer: assistantText,
        workerId: id,
        provider: payload.provider || (w && w.kind) || null,
        model: totals.model || null,
        conversationId: (w && w.sessionId) || null,
        ts: new Date().toISOString(),
        tokensIn: typeof totals.promptTokens === 'number' ? totals.promptTokens : null,
        tokensOut: typeof totals.completionTokens === 'number' ? totals.completionTokens : null,
      });
    } catch { /* never let memory write break the chat */ }
  }
}

module.exports = { WorkerManager };
