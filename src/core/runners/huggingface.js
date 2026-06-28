// Hugging Face plain-chat runner = the generic OpenAI-compatible runner
// wired to the Hugging Face preset factory. Sibling of runners/openrouter.js.

const { createHuggingFacePreset } = require('../llm/presets/huggingface');
const { OpenAICompatibleRunner } = require('./openAICompatible');

class HuggingFaceRunner extends OpenAICompatibleRunner {
  constructor(opts = {}) {
    super(createHuggingFacePreset, opts);
  }
}

module.exports = { HuggingFaceRunner };
