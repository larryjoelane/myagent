// OpenRouter plain-chat runner = the generic OpenAI-compatible runner
// wired to the OpenRouter preset factory. Sibling of runners/ollama.js.

const { createOpenRouterPreset } = require('../llm/presets/openrouter');
const { OpenAICompatibleRunner } = require('./openAICompatible');

class OpenRouterRunner extends OpenAICompatibleRunner {
  constructor(opts = {}) {
    super(createOpenRouterPreset, opts);
  }
}

module.exports = { OpenRouterRunner };
