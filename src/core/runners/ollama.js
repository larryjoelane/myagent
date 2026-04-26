// OllamaRunner — talks to a local Ollama server via its HTTP API.
// Implements the Runner interface used by the Agent:
//   async health(): { ok: boolean, version?: string }
//   async *stream(messages, opts): AsyncGenerator<string>  // yields token text

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL =
  process.env.MYAGENT_MODEL || 'hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M';

class OllamaRunner {
  constructor({ host = DEFAULT_HOST, model = DEFAULT_MODEL } = {}) {
    this.host = host.replace(/\/$/, '');
    this.model = model;
  }

  async health({ timeoutMs = 3000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/version`, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      const body = await res.json();
      return { ok: true, version: body.version };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : err?.message || 'unreachable';
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(messages, { signal } = {}) {
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let json;
        try { json = JSON.parse(line); } catch { continue; }

        if (json.error) throw new Error(json.error);
        const piece = json.message?.content;
        if (piece) yield piece;
        if (json.done) return;
      }
    }
  }
}

module.exports = { OllamaRunner };
