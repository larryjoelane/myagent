// Hugging Face Inference Endpoints preset — an OpenAI-compatible chat
// preset for a self-hosted HF TGI (text-generation-inference) endpoint.
// TGI exposes the standard OpenAI /v1/chat/completions route (streaming +
// tool calls, when the loaded model supports them), so almost everything
// is handled by OpenAIChat. Sibling of presets/openrouter.js.
//
// What lives here (HF-specific):
//   - base URL is the per-endpoint hostname (no fixed default — every HF
//     Inference Endpoint gets a unique subdomain), read from
//     HUGGINGFACE_ENDPOINT_URL
//   - Bearer auth via HUGGINGFACE_API_KEY (HF calls this a "token", but the
//     wire format is the same Authorization: Bearer header)
//   - health() against TGI's native /health (not OpenAI-shaped)
//
// What lives in OpenAIChat:
//   - HTTP, JSON request body, streaming parser, structured event yield
//
// SSRF note: OpenAIChat's baseUrl allowlist only contains the fixed
// provider hosts (openrouter.ai, ollama.com, loopback). Every HF endpoint
// has a unique generated hostname, so there is no fixed host to bake in —
// operators MUST add their endpoint's hostname to MYAGENT_ALLOWED_HOSTS
// (comma-separated) before this preset can reach it. See openaiChat.js.
//
// The returned object matches the surface the OpenAICompatibleDriver uses:
// model/host/capabilities/setThink/health/stream.

const { OpenAIChat } = require('../openaiChat');

// No DEFAULT_HOST: unlike openrouter.ai/ollama.com, an HF Inference Endpoint
// has a unique per-deployment hostname. Callers must supply `host` (or set
// HUGGINGFACE_ENDPOINT_URL) — see OpenAICompatibleDriver's host resolution.
const DEFAULT_MODEL = 'tgi';

function createHuggingFacePreset({ host, model = DEFAULT_MODEL, apiKey } = {}) {
  if (!host) {
    throw new Error('createHuggingFacePreset: host is required (set HUGGINGFACE_ENDPOINT_URL or pass host)');
  }
  const baseUrl = host.replace(/\/$/, '');
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  // TGI's OpenAI-compatible route lives under /v1; chatPath is appended to
  // baseUrl, so the endpoint URL itself should be the bare host (no /v1).
  const chat = new OpenAIChat({
    baseUrl,
    headers,
    model,
    chatPath: '/v1/chat/completions',
    extraBody: { stream_options: { include_usage: true } },
  });

  return {
    get model() { return model; },
    get host() { return baseUrl; },
    // No reasoning toggle exposed generically across TGI models.
    get think() { return false; },
    get capabilities() { return { thinking: 'never', tagPair: null }; },

    async setThink(on) {
      if (on) return { ok: false, think: false, reason: 'Hugging Face preset does not expose a reasoning toggle' };
      return { ok: true, think: false };
    },

    // TGI has a native /health (no auth, no OpenAI shape) rather than a
    // /models list — reuse OpenAIChat.health with that path.
    health(opts = {}) { return chat.health({ healthPath: '/health', ...opts }); },

    prepareMessages(messages) { return messages; },

    async *stream(messages, opts = {}) {
      yield* chat.stream(messages, opts);
    },
  };
}

module.exports = { createHuggingFacePreset, DEFAULT_MODEL };
