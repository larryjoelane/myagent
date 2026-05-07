// OllamaRunner — talks to a local Ollama server via its HTTP API.
//
// Implements the runner contract documented in ./index.js. Each Ollama
// model has its own conventions for how reasoning is gated and emitted, so
// the runner consults a per-model profile (see MODEL_PROFILES below) to
// decide:
//   - how to toggle thinking (directive in system prompt, none, etc.)
//   - what tag pair (if any) wraps reasoning in the content stream
// Adding a new local model is one entry in MODEL_PROFILES.

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL =
  process.env.MYAGENT_MODEL || 'hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M';

// Match a model id (e.g. "hf.co/.../SmolLM3-3B-GGUF:Q4_K_M",
// "qwen3:8b", "llama3.2:3b") against profile keys. Keys are matched as
// case-insensitive substrings of the model id.
const MODEL_PROFILES = {
  // SmolLM3: hybrid thinker. Gated by /think and /no_think system-prompt
  // directives (the Ollama top-level `think` flag is unreliable for
  // community GGUF ports). Reasoning is wrapped in <think>...</think> in
  // the content stream.
  smollm3: {
    thinking: 'directive',
    tagPair: ['<think>', '</think>'],
    onDirective: '/think',
    offDirective: '/no_think',
    defaultThink: false,
  },
  // Qwen3: same convention as SmolLM3 (/think, /no_think, <think> tags).
  qwen3: {
    thinking: 'directive',
    tagPair: ['<think>', '</think>'],
    onDirective: '/think',
    offDirective: '/no_think',
    defaultThink: false,
  },
  // DeepSeek-R1: always reasons; can't be turned off. Reasoning is in
  // <think>...</think>.
  'deepseek-r1': {
    thinking: 'always-on',
    tagPair: ['<think>', '</think>'],
    defaultThink: true,
  },
  // Llama 3.x, Mistral, Gemma, etc.: no reasoning step.
  llama: { thinking: 'never', defaultThink: false },
  mistral: { thinking: 'never', defaultThink: false },
  gemma: { thinking: 'never', defaultThink: false },
};

const DEFAULT_PROFILE = { thinking: 'unknown', defaultThink: false };

function profileFor(modelId) {
  const id = modelId.toLowerCase();
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    if (id.includes(key)) return profile;
  }
  return DEFAULT_PROFILE;
}

class OllamaRunner {
  constructor({ host = DEFAULT_HOST, model = DEFAULT_MODEL, think, apiKey } = {}) {
    this.host = host.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey || null;
    this.profile = profileFor(model);
    this.think = think !== undefined ? !!think : this.profile.defaultThink;
  }

  _headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  get capabilities() {
    return {
      thinking: this.profile.thinking,
      tagPair: this.profile.tagPair,
    };
  }

  async setThink(on) {
    const want = !!on;
    const kind = this.profile.thinking;
    if (kind === 'never' && want) {
      return { ok: false, think: this.think, reason: `${this.model} has no reasoning step` };
    }
    if (kind === 'always-on' && !want) {
      return { ok: false, think: this.think, reason: `${this.model} always reasons; cannot disable` };
    }
    this.think = want;
    return { ok: true, think: this.think };
  }

  async health({ timeoutMs = 3000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/version`, { signal: ctrl.signal, headers: this._headers() });
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

  // Inject the directive (if any) into the first system message before
  // shipping to Ollama. The agent passes a generic prompt; we make it
  // model-specific here so callers don't need to know.
  prepareMessages(messages) {
    const directive = this.think ? this.profile.onDirective : this.profile.offDirective;
    if (!directive) return messages;
    return messages.map((m, i) => {
      if (i !== 0 || m.role !== 'system') return m;
      return { ...m, content: `${directive}\n\n${m.content}` };
    });
  }

  async *stream(messages, { signal } = {}) {
    const prepared = this.prepareMessages(messages);

    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ model: this.model, messages: prepared, stream: true }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // Strip in-band reasoning tags only when (a) the model uses them and
    // (b) thinking is off. When thinking is on we let it stream so the
    // user can see what the model is doing.
    const filter = makeTagFilter(
      this.profile.tagPair && !this.think ? this.profile.tagPair : null
    );
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
        if (piece) {
          const cleaned = filter.push(piece);
          if (cleaned) yield cleaned;
        }
        if (json.done) {
          const tail = filter.flush();
          if (tail) yield tail;
          return;
        }
      }
    }

    const tail = filter.flush();
    if (tail) yield tail;
  }
}

// Strips a [open, close] tag pair from a token stream. Pass null to
// disable filtering. Buffers across chunk boundaries so a tag split
// mid-token is still recognized; non-prefix text is emitted immediately
// for live streaming.
function makeTagFilter(tagPair) {
  if (!tagPair) return { push: (s) => s, flush: () => '' };
  const [OPEN, CLOSE] = tagPair;

  let inside = false;
  let buf = '';

  const couldStartTag = (s, tag) => {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n >= 1; n--) {
      if (s.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  };

  return {
    push(piece) {
      buf += piece;
      let out = '';
      while (buf.length) {
        if (inside) {
          const end = buf.indexOf(CLOSE);
          if (end === -1) {
            const hold = couldStartTag(buf, CLOSE);
            buf = hold ? buf.slice(buf.length - hold) : '';
            return out;
          }
          buf = buf.slice(end + CLOSE.length);
          inside = false;
        } else {
          const start = buf.indexOf(OPEN);
          if (start === -1) {
            const hold = couldStartTag(buf, OPEN);
            if (hold) {
              out += buf.slice(0, buf.length - hold);
              buf = buf.slice(buf.length - hold);
            } else {
              out += buf;
              buf = '';
            }
            return out;
          }
          out += buf.slice(0, start);
          buf = buf.slice(start + OPEN.length);
          inside = true;
        }
      }
      return out;
    },
    flush() {
      if (inside) return '';
      const out = buf;
      buf = '';
      return out;
    },
  };
}

module.exports = { OllamaRunner, MODEL_PROFILES };
