// Ollama preset — knows everything about how Ollama-family models handle
// reasoning. Layered on top of OpenAIChat so the protocol stays neutral.
//
// What lives here (Ollama-specific):
//   - MODEL_PROFILES: per-model thinking conventions
//   - prepareMessages: inject /think /no_think directives into system prompt
//   - in-band <think>...</think> stripping when thinking is off
//   - top-level `think` request flag for cloud reasoning models
//   - default host (local 11434 or cloud) and Bearer auth header
//
// What lives in OpenAIChat:
//   - HTTP, JSON request body, streaming parser, structured event yield

const { OpenAIChat } = require('../openaiChat');

const DEFAULT_LOCAL_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL =
  process.env.MYAGENT_MODEL || 'hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M';

const MODEL_PROFILES = {
  smollm3: {
    thinking: 'directive',
    tagPair: ['<think>', '</think>'],
    onDirective: '/think',
    offDirective: '/no_think',
    defaultThink: false,
  },
  qwen3: {
    thinking: 'directive',
    tagPair: ['<think>', '</think>'],
    onDirective: '/think',
    offDirective: '/no_think',
    defaultThink: false,
  },
  'deepseek-r1': {
    thinking: 'always-on',
    tagPair: ['<think>', '</think>'],
    defaultThink: true,
  },
  'glm-5.1': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'glm-5':   { thinking: 'api-field', apiThink: true, defaultThink: true },
  'glm-4.6': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'gpt-oss': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'qwen3-coder': { thinking: 'api-field', apiThink: true, defaultThink: true },
  'kimi-k2':     { thinking: 'api-field', apiThink: true, defaultThink: true },
  llama:   { thinking: 'never', defaultThink: false },
  mistral: { thinking: 'never', defaultThink: false },
  gemma:   { thinking: 'never', defaultThink: false },
};

const DEFAULT_PROFILE = { thinking: 'unknown', defaultThink: false };

function profileFor(modelId) {
  const id = String(modelId || '').toLowerCase();
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    if (id.includes(key)) return profile;
  }
  return DEFAULT_PROFILE;
}

// Build an OpenAIChat configured for an Ollama endpoint, plus a small
// adapter for Ollama-only behavior (think flag, directive injection,
// in-band tag filter when thinking is off).
function createOllamaPreset({ host, model = DEFAULT_MODEL, apiKey, think } = {}) {
  const baseUrl = (host || DEFAULT_LOCAL_HOST).replace(/\/$/, '');
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const profile = profileFor(model);
  let thinkOn = think !== undefined ? !!think : profile.defaultThink;

  const chat = new OpenAIChat({ baseUrl, headers, model, chatPath: '/api/chat' });

  return {
    get model() { return model; },
    get host() { return baseUrl; },
    get think() { return thinkOn; },
    get profile() { return profile; },
    get capabilities() {
      return { thinking: profile.thinking, tagPair: profile.tagPair };
    },

    async setThink(on) {
      const want = !!on;
      if (profile.thinking === 'never' && want) {
        return { ok: false, think: thinkOn, reason: `${model} has no reasoning step` };
      }
      if (profile.thinking === 'always-on' && !want) {
        return { ok: false, think: thinkOn, reason: `${model} always reasons; cannot disable` };
      }
      thinkOn = want;
      return { ok: true, think: thinkOn };
    },

    health(opts) { return chat.health(opts); },

    prepareMessages(messages) {
      const directive = thinkOn ? profile.onDirective : profile.offDirective;
      if (!directive) return messages;
      return messages.map((m, i) => {
        if (i !== 0 || m.role !== 'system') return m;
        return { ...m, content: `${directive}\n\n${m.content}` };
      });
    },

    // Yields structured events from openaiChat, but with two Ollama
    // adaptations: (a) inject /think directive on system prompt;
    // (b) when thinking is off and the profile has a tagPair, filter
    // <think>...</think> out of `content` deltas.
    async *stream(messages, opts = {}) {
      const prepared = this.prepareMessages(messages);
      const body = {};
      if (profile.thinking === 'api-field') body.think = !!thinkOn;

      const useFilter = profile.tagPair && !thinkOn;
      const filter = useFilter ? makeTagFilter(profile.tagPair) : null;

      for await (const ev of chat.stream(prepared, { ...opts, body })) {
        if (ev.type === 'content' && filter) {
          const cleaned = filter.push(ev.text);
          if (cleaned) yield { type: 'content', text: cleaned };
          continue;
        }
        if (ev.type === 'done' && filter) {
          const tail = filter.flush();
          if (tail) yield { type: 'content', text: tail };
        }
        yield ev;
      }
    },
  };
}

// Strips a [open, close] tag pair from a token stream. Buffers across
// chunk boundaries so a tag split mid-token is still recognized;
// non-prefix text is emitted immediately for live streaming.
function makeTagFilter(tagPair) {
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

module.exports = { createOllamaPreset, MODEL_PROFILES, profileFor, makeTagFilter };
