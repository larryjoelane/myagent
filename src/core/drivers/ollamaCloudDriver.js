// OllamaCloudDriver — chat-driven worker backed by Ollama's hosted
// HTTP API (https://ollama.com).
//
// Two modes:
//
//   1. Plain chat (default when `tools` is not enabled): consumes a
//      legacy string-yielding runner via `runnerFactory` (OllamaRunner).
//      Each chunk -> chat:chunk. Same behavior shipped before tool-use.
//
//   2. Tool-use (when `tools: true` and `presetFactory` + `toolRegistry`
//      are wired): builds an OpenAI-format preset via `presetFactory`
//      and drives a ToolUseLoop. The loop streams structured events
//      (content, thinking, tool_call, tool-result) which we surface as:
//        chat:chunk { kind: 'text',     text }
//        chat:chunk { kind: 'thinking', text }
//        chat:tool-call   { call: { id, name, arguments } }
//        chat:tool-result { call, result: { ok, content, data? } }
//
// Either way: chat:user, chat:turn-start, chat:turn-end open and close
// each turn, identical to the other drivers.
//
// Config is env-only by default:
//   OLLAMA_API_KEY  — required; without it the driver refuses to start
//   OLLAMA_MODEL    — defaults to gpt-oss:120b-cloud
//   OLLAMA_HOST     — override (defaults to https://ollama.com)

const { ToolUseLoop } = require('../llm/toolUseLoop');

const DEFAULT_HOST = 'https://ollama.com';
const DEFAULT_MODEL = 'gpt-oss:120b-cloud';

class OllamaCloudDriver {
  constructor({
    agentId,
    runnerFactory,
    presetFactory,
    toolRegistry,
    tools = false,
    scope,
    cwd,
    memory,
    apiKey,
    host,
    model,
    onEvent,
    maxIterations,
  } = {}) {
    if (typeof runnerFactory !== 'function' && typeof presetFactory !== 'function') {
      throw new Error('OllamaCloudDriver: runnerFactory or presetFactory is required');
    }
    if (tools && (typeof presetFactory !== 'function' || !toolRegistry)) {
      throw new Error('OllamaCloudDriver: tools=true requires presetFactory and toolRegistry');
    }
    this.agentId = agentId;
    this.apiKey = apiKey || process.env.OLLAMA_API_KEY || null;
    this.host = host || process.env.OLLAMA_HOST || DEFAULT_HOST;
    this.model = model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
    this.onEvent = onEvent || (() => {});
    this.runnerFactory = runnerFactory;
    this.presetFactory = presetFactory;
    this.toolRegistry = toolRegistry || null;
    this.toolsEnabled = !!tools;
    this.scope = scope || null;
    this.cwd = cwd || null;
    // Memory backend for memory_search / memory_store tools. Shape:
    // { search({query, limit, minConfidence}), store({text, source, tags}) }.
    // Optional — tools refuse cleanly when missing.
    this.memory = memory || null;
    this.maxIterations = maxIterations;

    this.runner = null;     // legacy string-yielding runner (plain mode)
    this.preset = null;     // structured-event runner (tools mode)
    this.messages = [];
    this.started = false;
    this.closed = false;
    this.turnActive = false;
    this.abortCtrl = null;
  }

  async start() {
    if (this.started || this.closed) return;
    if (!this.apiKey) {
      this.started = true;
      this._emit('chat:error', { error: 'OLLAMA_API_KEY not set in .env' });
      this._emit('chat:driver-exit', { reason: 'missing-api-key' });
      return;
    }
    if (this.toolsEnabled) {
      this.preset = this.presetFactory({
        host: this.host,
        model: this.model,
        apiKey: this.apiKey,
      });
    } else {
      this.runner = this.runnerFactory({
        host: this.host,
        model: this.model,
        apiKey: this.apiKey,
      });
    }
    this.started = true;
  }

  send(text) {
    if (this.closed) {
      this._emit('chat:error', { error: 'driver closed' });
      return;
    }
    if (!this.started) {
      this._emit('chat:error', { error: 'driver not started' });
      return;
    }
    if (!this.runner && !this.preset) {
      // start() failed (no API key); already emitted error+exit
      return;
    }
    if (this.turnActive) {
      this._emit('chat:error', { error: 'previous turn still in progress' });
      return;
    }
    const userText = String(text || '');
    if (!userText.trim()) return;

    this.turnActive = true;
    this._emit('chat:user', { text: userText });
    this._emit('chat:turn-start', {});

    const fn = this.toolsEnabled ? this._runTurnTools(userText) : this._runTurnPlain(userText);
    fn.catch((err) => {
      this._emit('chat:error', { error: err?.message || String(err) });
      this._emit('chat:turn-end', {
        userText,
        assistantText: '',
        ok: false,
        error: err?.message || String(err),
      });
      this.turnActive = false;
    });
  }

  async _runTurnPlain(userText) {
    this.messages.push({ role: 'user', content: userText });
    this.abortCtrl = new AbortController();
    let assistantText = '';
    try {
      for await (const chunk of this.runner.stream(this.messages, { signal: this.abortCtrl.signal })) {
        if (this.closed) break;
        if (!chunk) continue;
        assistantText += chunk;
        this._emit('chat:chunk', { kind: 'text', text: chunk });
      }
      this.messages.push({ role: 'assistant', content: assistantText });
      this._emit('chat:turn-end', {
        userText,
        assistantText,
        ok: true,
        totals: { model: this.model },
      });
    } finally {
      this.turnActive = false;
      this.abortCtrl = null;
    }
  }

  async _runTurnTools(userText) {
    this.messages.push({ role: 'user', content: userText });
    this.abortCtrl = new AbortController();
    const ctx = {
      scope: this.scope,
      cwd: this.cwd,
      memory: this.memory,
      agentId: this.agentId,
    };
    const loop = new ToolUseLoop({
      runner: this.preset,
      registry: this.toolRegistry,
      ctx,
      maxIterations: this.maxIterations,
      onEvent: (ev) => {
        if (this.closed) return;
        if (ev.type === 'content') {
          this._emit('chat:chunk', { kind: 'text', text: ev.text });
        } else if (ev.type === 'thinking') {
          this._emit('chat:chunk', { kind: 'thinking', text: ev.text });
        } else if (ev.type === 'tool-call') {
          this._emit('chat:tool-call', { call: ev.call });
        } else if (ev.type === 'tool-result') {
          this._emit('chat:tool-result', { call: ev.call, result: ev.result });
        }
      },
    });
    try {
      const result = await loop.run(this.messages, { signal: this.abortCtrl.signal });
      this.messages = result.messages;
      this._emit('chat:turn-end', {
        userText,
        assistantText: result.assistantText,
        ok: true,
        totals: { model: this.model, iterations: result.iterations, ...(result.totals || {}) },
        hitMaxIterations: !!result.hitMaxIterations,
      });
    } finally {
      this.turnActive = false;
      this.abortCtrl = null;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.abortCtrl) {
      try { this.abortCtrl.abort(); } catch { /* ignore */ }
    }
    this._emit('chat:driver-exit', { reason: 'closed' });
  }

  _emit(name, payload) {
    this.onEvent(name, { agentId: this.agentId, ...payload });
  }
}

module.exports = { OllamaCloudDriver };
