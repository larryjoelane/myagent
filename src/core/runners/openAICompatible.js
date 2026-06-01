// Generic plain-chat runner for any OpenAI-compatible preset.
//
// The legacy runner contract (see runners/index.js) is: stream() yields
// plain text strings; callers don't see structured thinking/tool_call
// events. This class adapts ANY preset (createOllamaPreset,
// createOpenRouterPreset, …) to that contract, so each provider's runner
// is just "this class + that provider's preset factory" rather than a
// near-identical copy.
//
// New code should consume the preset directly and handle the structured
// stream (that's what ToolUseLoop does). This shim exists for the
// plain-chat (tools:false) path of OpenAICompatibleDriver.

class OpenAICompatibleRunner {
  /**
   * @param {(opts: object) => object} presetFactory - builds the preset
   * @param {object} [opts] - forwarded to the preset factory (host/model/apiKey)
   */
  constructor(presetFactory, opts = {}) {
    if (typeof presetFactory !== 'function') {
      throw new Error('OpenAICompatibleRunner: presetFactory function is required');
    }
    this._preset = presetFactory(opts);
  }

  get host() { return this._preset.host; }
  get model() { return this._preset.model; }
  get think() { return this._preset.think; }
  get capabilities() { return this._preset.capabilities; }
  // Some presets (Ollama) expose a model profile; others (OpenRouter) don't.
  get profile() { return this._preset.profile; }

  setThink(on) { return this._preset.setThink(on); }
  health(opts) { return this._preset.health(opts); }
  prepareMessages(messages) {
    return typeof this._preset.prepareMessages === 'function'
      ? this._preset.prepareMessages(messages)
      : messages;
  }

  // Legacy interface: yields plain strings (visible content only).
  // Thinking deltas and tool_calls are dropped for back-compat.
  async *stream(messages, opts = {}) {
    for await (const ev of this._preset.stream(messages, opts)) {
      if (ev.type === 'content' && ev.text) yield ev.text;
    }
  }
}

module.exports = { OpenAICompatibleRunner };
