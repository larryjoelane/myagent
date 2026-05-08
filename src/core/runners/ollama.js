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
//
// Profiles describe how a model handles reasoning, so the runner knows:
//   - whether to inject /think /no_think directives into the system prompt
//     (legacy SmolLM3/Qwen3 GGUF ports, not honored by the cloud API)
//   - whether reasoning is wrapped in in-band <think>...</think> tags
//     (GGUF community ports; the runner strips them when think is off)
//   - whether to send the structured top-level `think` flag in the
//     /api/chat request body (Ollama Cloud reasoning models like
//     gpt-oss, glm-5.1, deepseek-v4 — the cloud surfaces reasoning
//     in `message.thinking` separately from `message.content` when
//     this flag is on)
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
  // DeepSeek-R1 (local GGUF): always reasons; can't be turned off.
  // Reasoning is in <think>...</think>.
  'deepseek-r1': {
    thinking: 'always-on',
    tagPair: ['<think>', '</think>'],
    defaultThink: true,
  },
  // Cloud reasoning models. These honor the structured top-level `think`
  // flag in the request body, and surface reasoning in message.thinking
  // (NOT in-band tags). Without sending think=true, GLM 5.1 streams
  // thinking-only chunks and never yields message.content — manifests as
  // "(no response)" on the chat surface. Always send think.
  'glm-5.1': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'glm-5':   { thinking: 'api-field', apiThink: true, defaultThink: true },
  'glm-4.6': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'gpt-oss': { thinking: 'api-field', apiThink: true, defaultThink: true },
  // qwen3-coder and kimi-k2 cloud variants — surface reasoning when asked,
  // but don't strictly require it. Send think=true for parity.
  'qwen3-coder': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'kimi-k2':     { thinking: 'api-field', apiThink: true, defaultThink: true },
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

    // Build the request body. For models with `thinking: 'api-field'`
    // we send the structured top-level `think` flag so the cloud
    // produces both a thinking trace AND a final content answer. Without
    // it, GLM 5.1 (and other reasoner cloud models) stream thinking-only
    // chunks and never yield message.content — surfaces as "(no response)".
    /** @type {Record<string, unknown>} */
    const body = { model: this.model, messages: prepared, stream: true };
    if (this.profile.thinking === 'api-field') {
      body.think = !!this.think;
    }

    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
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
    // user can see what the model is doing. Cloud reasoning models
    // (api-field) don't use in-band tags — they surface reasoning in a
    // separate message.thinking field — so the filter is a no-op for them.
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
        // Cloud reasoning models stream `message.thinking` chunks during
        // the reasoning phase and `message.content` chunks for the final
        // answer. We only yield content — reasoning UX is a future pass
        // (a separate channel so it can be styled/hidden by the renderer).
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
