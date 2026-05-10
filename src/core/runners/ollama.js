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

class OllamaRunner {
  constructor(opts = {}) {
    this._preset = createOllamaPreset(opts);
  }

  get host() { return this._preset.host; }
  get model() { return this._preset.model; }
  get think() { return this._preset.think; }
  get capabilities() { return this._preset.capabilities; }
  get profile() { return this._preset.profile; }

  setThink(on) { return this._preset.setThink(on); }
  health(opts) { return this._preset.health(opts); }
  prepareMessages(messages) { return this._preset.prepareMessages(messages); }

  // Legacy interface: yields plain strings (visible content only).
  // Thinking deltas and tool_calls are dropped for back-compat.
  async *stream(messages, opts = {}) {
    for await (const ev of this._preset.stream(messages, opts)) {
      if (ev.type === 'content' && ev.text) yield ev.text;
    }
  }
}

module.exports = { OllamaRunner, MODEL_PROFILES, profileFor };
