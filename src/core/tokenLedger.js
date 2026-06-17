// TokenLedger — in-memory tally of LLM token usage, keyed by
// {provider, model, agentId}. Persists to a JSON file in the
// user-data directory so totals survive app restarts.
//
// Drivers call `record({ provider, model, agentId, inputTokens,
// outputTokens, ts })` at turn-end. Subscribers (IPC layer →
// renderer chip) get notified via `subscribe(fn)`.
//
// Shape kept deliberately flat so a future analytics panel can
// pivot on any axis (by provider, by model, by agent, by day)
// without a schema migration.

const fs = require('fs');
const path = require('path');
const { safeJoin } = require('./safePath');

const SCHEMA_VERSION = 1;
// Flush at most every FLUSH_MS so a chatty driver doesn't hammer
// the disk; also flush on close().
const FLUSH_MS = 2000;

class TokenLedger {
  /**
   * @param {object} opts
   * @param {string} [opts.persistPath] - where to read/write the JSON.
   *   When omitted the ledger is memory-only (used by tests).
   */
  constructor({ persistPath } = {}) {
    // Pin to an absolute path so the fs ops below operate on a fixed, contained
    // target rather than a value re-derived from input (js/path-injection). A
    // relative persistPath is a caller error.
    if (persistPath && !path.isAbsolute(persistPath)) {
      throw new Error(`TokenLedger: persistPath must be absolute, got: ${persistPath}`);
    }
    // Route through safeJoin (resolve + containment barrier) so the persisted
    // fs ops below operate on a path that passed the traversal check.
    this.persistPath = persistPath
      ? safeJoin(path.dirname(persistPath), path.basename(persistPath))
      : null;
    /** @type {Map<string, AgentTotals>} */
    this.byAgent = new Map();
    /** @type {Array<TurnRecord>} */
    this.recent = [];
    this.recentMax = 200;
    /** @type {Set<(snap: Snapshot) => void>} */
    this.subscribers = new Set();
    this._dirty = false;
    /** @type {NodeJS.Timeout | null} */
    this._flushTimer = null;
    this._closed = false;

    if (this.persistPath) this._loadFromDisk();
  }

  /**
   * Record one turn's usage.
   * @param {object} ev
   * @param {string} ev.provider     - 'ollama-cloud', 'claude', 'openai', etc.
   * @param {string} ev.model        - model id ('devstral-small-2:24b-cloud')
   * @param {string} ev.agentId      - worker id
   * @param {number} [ev.inputTokens]
   * @param {number} [ev.outputTokens]
   * @param {number} [ev.ts]         - unix ms; defaults to Date.now()
   */
  record(ev) {
    if (this._closed) return;
    if (!ev || !ev.provider || !ev.model || !ev.agentId) return;
    const inT = Number.isFinite(ev.inputTokens) ? ev.inputTokens : 0;
    const outT = Number.isFinite(ev.outputTokens) ? ev.outputTokens : 0;
    // No-op record. Don't dirty the ledger or notify subscribers — a
    // turn-end with no usage data shouldn't bump counters.
    if (inT === 0 && outT === 0) return;

    const ts = Number.isFinite(ev.ts) ? ev.ts : Date.now();
    const agent = this._ensureAgent(ev.agentId);
    agent.inputTokens += inT;
    agent.outputTokens += outT;
    agent.turns += 1;
    agent.lastTs = ts;
    agent.provider = ev.provider;
    agent.model = ev.model;

    const modelKey = `${ev.provider}::${ev.model}`;
    let perModel = agent.byModel.get(modelKey);
    if (!perModel) {
      perModel = { provider: ev.provider, model: ev.model,
        inputTokens: 0, outputTokens: 0, turns: 0 };
      agent.byModel.set(modelKey, perModel);
    }
    perModel.inputTokens += inT;
    perModel.outputTokens += outT;
    perModel.turns += 1;

    this.recent.push({
      ts, agentId: ev.agentId, provider: ev.provider, model: ev.model,
      inputTokens: inT, outputTokens: outT,
    });
    if (this.recent.length > this.recentMax) {
      this.recent.splice(0, this.recent.length - this.recentMax);
    }
    this._dirty = true;
    this._scheduleFlush();
    this._notify();
  }

  /** Remove an agent's tallies. Used when a worker is closed. */
  forget(agentId) {
    if (!this.byAgent.has(agentId)) return;
    this.byAgent.delete(agentId);
    this._dirty = true;
    this._scheduleFlush();
    this._notify();
  }

  /** Wipe everything. UI-facing; the persisted file is rewritten empty. */
  reset() {
    this.byAgent.clear();
    this.recent.length = 0;
    this._dirty = true;
    this._scheduleFlush();
    this._notify();
  }

  /** Snapshot of one agent's tallies (or null if unknown). */
  byWorker(agentId) {
    const a = this.byAgent.get(agentId);
    if (!a) return null;
    return serializeAgent(a);
  }

  /** Full snapshot: per-agent + per-model + per-provider rollups. */
  snapshot() {
    /** @type {Snapshot} */
    const snap = {
      schemaVersion: SCHEMA_VERSION,
      totals: { inputTokens: 0, outputTokens: 0, turns: 0 },
      byProvider: {},
      byModel: [],
      byAgent: [],
      recent: this.recent.slice(),
    };
    /** @type {Map<string, ModelRollup>} */
    const modelRoll = new Map();
    for (const [agentId, a] of this.byAgent) {
      snap.totals.inputTokens += a.inputTokens;
      snap.totals.outputTokens += a.outputTokens;
      snap.totals.turns += a.turns;
      snap.byAgent.push(serializeAgent(a, agentId));
      for (const [k, m] of a.byModel) {
        let r = modelRoll.get(k);
        if (!r) {
          r = { provider: m.provider, model: m.model,
            inputTokens: 0, outputTokens: 0, turns: 0 };
          modelRoll.set(k, r);
        }
        r.inputTokens += m.inputTokens;
        r.outputTokens += m.outputTokens;
        r.turns += m.turns;
      }
    }
    for (const r of modelRoll.values()) {
      snap.byModel.push(r);
      const p = snap.byProvider[r.provider] || {
        provider: r.provider, inputTokens: 0, outputTokens: 0, turns: 0 };
      p.inputTokens += r.inputTokens;
      p.outputTokens += r.outputTokens;
      p.turns += r.turns;
      snap.byProvider[r.provider] = p;
    }
    return snap;
  }

  /** Subscribe to change events; returns an unsubscribe fn. */
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Flush pending writes and stop the timer. Idempotent. */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._dirty) this._flushToDisk();
  }

  // --- internals ---------------------------------------------------------

  _ensureAgent(agentId) {
    let a = this.byAgent.get(agentId);
    if (!a) {
      a = {
        agentId, provider: '', model: '',
        inputTokens: 0, outputTokens: 0, turns: 0,
        lastTs: 0,
        /** @type {Map<string, PerModel>} */
        byModel: new Map(),
      };
      this.byAgent.set(agentId, a);
    }
    return a;
  }

  _notify() {
    if (this.subscribers.size === 0) return;
    let snap = null;
    for (const fn of this.subscribers) {
      try {
        if (!snap) snap = this.snapshot();
        fn(snap);
      } catch { /* ignore subscriber errors */ }
    }
  }

  _scheduleFlush() {
    if (!this.persistPath || this._flushTimer || this._closed) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._dirty) this._flushToDisk();
    }, FLUSH_MS);
    // Don't keep the event loop alive just to flush.
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  _flushToDisk() {
    if (!this.persistPath) { this._dirty = false; return; }
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(this._serialize(), null, 2);
      // Atomic-ish: write to .tmp then rename. Avoids half-written
      // files if the process dies mid-write.
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.persistPath);
      this._dirty = false;
    } catch { /* persistence failure is non-fatal */ }
  }

  _loadFromDisk() {
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const json = JSON.parse(raw);
      if (!json || json.schemaVersion !== SCHEMA_VERSION) return;
      for (const a of json.byAgent || []) {
        const agent = this._ensureAgent(a.agentId);
        agent.provider = a.provider || '';
        agent.model = a.model || '';
        agent.inputTokens = a.inputTokens | 0;
        agent.outputTokens = a.outputTokens | 0;
        agent.turns = a.turns | 0;
        agent.lastTs = a.lastTs | 0;
        for (const m of a.byModel || []) {
          const k = `${m.provider}::${m.model}`;
          agent.byModel.set(k, {
            provider: m.provider, model: m.model,
            inputTokens: m.inputTokens | 0,
            outputTokens: m.outputTokens | 0,
            turns: m.turns | 0,
          });
        }
      }
      if (Array.isArray(json.recent)) {
        for (const r of json.recent) {
          if (this.recent.length >= this.recentMax) break;
          this.recent.push(r);
        }
      }
    } catch { /* missing or corrupt — start empty */ }
  }

  _serialize() {
    return {
      schemaVersion: SCHEMA_VERSION,
      byAgent: Array.from(this.byAgent.values()).map((a) => serializeAgent(a)),
      recent: this.recent,
    };
  }
}

function serializeAgent(a, agentId) {
  return {
    agentId: agentId || a.agentId,
    provider: a.provider,
    model: a.model,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    turns: a.turns,
    lastTs: a.lastTs,
    byModel: Array.from(a.byModel.values()),
  };
}

// Extract normalized {inputTokens, outputTokens} from whatever shape
// a driver passes in totals. Returns {inputTokens, outputTokens} with
// 0 fallback for missing fields. Supports:
//
//   Ollama:  { promptEvalCount, evalCount }            (extractTotals in openaiChat.js)
//   OpenAI:  { usage: { prompt_tokens, completion_tokens } }
//   Claude:  { usage: { input_tokens, output_tokens } }
//   Already-normalized: { inputTokens, outputTokens }
function normalizeUsage(totals) {
  if (!totals || typeof totals !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }
  if (Number.isFinite(totals.inputTokens) || Number.isFinite(totals.outputTokens)) {
    return {
      inputTokens: Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0,
      outputTokens: Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0,
    };
  }
  const usage = totals.usage || {};
  let inT = 0;
  let outT = 0;
  if (Number.isFinite(totals.promptEvalCount)) inT = totals.promptEvalCount;
  else if (Number.isFinite(usage.prompt_tokens)) inT = usage.prompt_tokens;
  else if (Number.isFinite(usage.input_tokens)) inT = usage.input_tokens;
  if (Number.isFinite(totals.evalCount)) outT = totals.evalCount;
  else if (Number.isFinite(usage.completion_tokens)) outT = usage.completion_tokens;
  else if (Number.isFinite(usage.output_tokens)) outT = usage.output_tokens;
  return { inputTokens: inT | 0, outputTokens: outT | 0 };
}

module.exports = { TokenLedger, normalizeUsage };

/**
 * @typedef {object} AgentTotals
 * @property {string} agentId
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} turns
 * @property {number} lastTs
 * @property {Map<string, PerModel>} byModel
 */

/**
 * @typedef {object} PerModel
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} turns
 */

/**
 * @typedef {object} TurnRecord
 * @property {number} ts
 * @property {string} agentId
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 */

/**
 * @typedef {object} ModelRollup
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} turns
 */

/**
 * @typedef {object} Snapshot
 * @property {number} schemaVersion
 * @property {{ inputTokens: number, outputTokens: number, turns: number }} totals
 * @property {Record<string, { provider: string, inputTokens: number, outputTokens: number, turns: number }>} byProvider
 * @property {ModelRollup[]} byModel
 * @property {Array<object>} byAgent
 * @property {TurnRecord[]} recent
 */
