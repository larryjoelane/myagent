// OllamaCloudDriver — chat-driven worker backed by Ollama's hosted
// HTTP API (https://ollama.com). Reuses OllamaRunner end-to-end: same
// /api/chat endpoint, same NDJSON streaming, same thinking-tag filter.
// The only Cloud-specific bit is the Authorization: Bearer header.
//
// Config is env-only (per project decision):
//   OLLAMA_API_KEY  — required; without it the driver refuses to start
//   OLLAMA_MODEL    — defaults to gpt-oss:120b-cloud
//   OLLAMA_HOST     — override (defaults to https://ollama.com)
//
// Conversation state lives on the driver: each send() appends to
// `messages` and walks the runner's stream, accumulating assistant text
// for the memory mirror. close() aborts the in-flight request.

const DEFAULT_HOST = 'https://ollama.com';
const DEFAULT_MODEL = 'glm-5.1:cloud';

class OllamaCloudDriver {
  constructor({ agentId, runnerFactory, apiKey, host, model, onEvent } = {}) {
    if (typeof runnerFactory !== 'function') {
      throw new Error('OllamaCloudDriver: runnerFactory is required');
    }
    this.agentId = agentId;
    this.apiKey = apiKey || process.env.OLLAMA_API_KEY || null;
    this.host = host || process.env.OLLAMA_HOST || DEFAULT_HOST;
    this.model = model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
    this.onEvent = onEvent || (() => {});
    this.runnerFactory = runnerFactory;
    this.runner = null;
    this.messages = [];
    this.started = false;
    this.closed = false;
    this.turnActive = false;
    this.abortCtrl = null;
  }

  async start() {
    if (this.started || this.closed) return;
    if (!this.apiKey) {
      // Surface a clear error and exit cleanly so the worker doesn't
      // linger in the registry — WorkerChannel listens for driver-exit.
      this.started = true;
      this._emit('chat:error', { error: 'OLLAMA_API_KEY not set in .env' });
      this._emit('chat:driver-exit', { reason: 'missing-api-key' });
      return;
    }
    this.runner = this.runnerFactory({
      host: this.host,
      model: this.model,
      apiKey: this.apiKey,
    });
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
    if (!this.runner) {
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

    this._runTurn(userText).catch((err) => {
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

  async _runTurn(userText) {
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
