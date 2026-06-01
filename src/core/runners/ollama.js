// Back-compat shim for the legacy OllamaRunner interface.
//
// The protocol + Ollama-specific behavior moved to src/core/llm/. This
// file adapts that to the original runner contract (see runners/index.js):
// stream() yields plain text strings, callers don't see the structured
// thinking/tool_call events.
//
// New code should consume `createOllamaPreset` directly and handle the
// structured stream — that's what ToolUseLoop will do. This shim exists
// so OllamaCloudDriver and electron/main.js keep working unchanged.

const { createOllamaPreset, MODEL_PROFILES, profileFor } = require('../llm/presets/ollama');
const { OpenAICompatibleRunner } = require('./openAICompatible');

// Ollama-cloud plain-chat runner = the generic OpenAI-compatible runner
// wired to the Ollama preset factory. The shared base does all the work.
class OllamaRunner extends OpenAICompatibleRunner {
  constructor(opts = {}) {
    super(createOllamaPreset, opts);
  }
}

module.exports = { OllamaRunner, MODEL_PROFILES, profileFor };
