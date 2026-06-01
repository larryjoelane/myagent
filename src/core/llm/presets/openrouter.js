// OpenRouter preset — an OpenAI-compatible chat preset for
// https://openrouter.ai. Thin by design: OpenRouter speaks the standard
// OpenAI /chat/completions protocol (streaming + tool calls), so almost
// everything is handled by OpenAIChat. There are no Ollama-style thinking
// profiles or /think directives here.
//
// What lives here (OpenRouter-specific):
//   - base URL (https://openrouter.ai/api/v1) + /chat/completions path
//   - Bearer auth (OPENROUTER_API_KEY)
//   - OpenRouter's recommended attribution headers (HTTP-Referer, X-Title)
//   - health() against /models (OpenRouter has no /api/version)
//
// What lives in OpenAIChat:
//   - HTTP, JSON request body, streaming parser, structured event yield
//
// The returned object matches the surface the OpenAICompatibleDriver and
// OpenRouterRunner use: model/host/capabilities/setThink/health/stream.
// (No `profile`/`think` semantics — setThink is a no-op so callers that
// toggle reasoning don't crash.)

const { OpenAIChat } = require('../openaiChat');

const DEFAULT_HOST = 'https://openrouter.ai/api/v1';
// Devstral Small — Mistral's agentic coding model. (If OpenRouter shows no
// active provider endpoints for this slug, mistralai/devstral-2512 is the
// fully-served alternative.)
const DEFAULT_MODEL = 'mistralai/devstral-small';

// Sent so OpenRouter can attribute requests to this app (optional but
// recommended by their docs). Overridable via env for forks/deploys.
const APP_REFERER = process.env.OPENROUTER_REFERER || 'https://github.com/larryjoelane/MyAgent';
const APP_TITLE = process.env.OPENROUTER_TITLE || 'MyAgent';

function createOpenRouterPreset({ host, model = DEFAULT_MODEL, apiKey } = {}) {
  const baseUrl = (host || DEFAULT_HOST).replace(/\/$/, '');
  const headers = {
    'HTTP-Referer': APP_REFERER,
    'X-Title': APP_TITLE,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  // OpenRouter is OpenAI-standard: /chat/completions, not Ollama's /api/chat.
  const chat = new OpenAIChat({ baseUrl, headers, model, chatPath: '/chat/completions' });

  return {
    get model() { return model; },
    get host() { return baseUrl; },
    // No reasoning toggle for the generic OpenRouter path: 'never' keeps the
    // think-capability checks in the driver/UI consistent with a model that
    // doesn't expose a separate reasoning step.
    get think() { return false; },
    get capabilities() { return { thinking: 'never', tagPair: null }; },

    // Accepting setThink keeps the runner/driver interface uniform with the
    // Ollama preset; turning thinking on is simply unsupported here.
    async setThink(on) {
      if (on) return { ok: false, think: false, reason: 'OpenRouter preset does not expose a reasoning toggle' };
      return { ok: true, think: false };
    },

    // OpenRouter has no /api/version; /models returns 200 with a list when
    // the key + connectivity are good. Reuses OpenAIChat.health with an
    // OpenRouter-appropriate path.
    health(opts = {}) { return chat.health({ healthPath: '/models', ...opts }); },

    // No message rewriting needed — pass through.
    prepareMessages(messages) { return messages; },

    // Straight pass-through of the structured event stream. OpenAIChat's
    // parser maps a `delta.reasoning_content` field to { type: 'thinking' }
    // events; reasoning surfaced under other field names (some OpenRouter
    // models use `reasoning`) is currently treated as ordinary content.
    // Broadening that mapping is a parser concern, out of scope here.
    async *stream(messages, opts = {}) {
      yield* chat.stream(messages, opts);
    },
  };
}

module.exports = { createOpenRouterPreset, DEFAULT_HOST, DEFAULT_MODEL };
