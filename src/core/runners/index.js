// Runner registry + contract.
//
// Every runner MUST expose:
//   async health()                       -> { ok, version?, reason? }
//   async *stream(messages, opts)        -> yields visible text chunks
//                                            (reasoning tokens are not
//                                            yielded here; see below)
//   capabilities: { thinking: ThinkKind, tagPair?: [string, string] }
//   think: boolean                       -> current state (false if N/A)
//   async setThink(on)                   -> { ok, think, reason? }
//
// ThinkKind describes how a runner can be toggled:
//   'directive'  — system-prompt directive (e.g. SmolLM3 /no_think)
//   'flag'       — top-level request flag (e.g. some Ollama models with
//                   the `thinking` capability declared)
//   'api-field'  — vendor request field (e.g. Anthropic thinking config)
//   'always-on'  — model always reasons; setThink(false) returns ok:false
//   'never'      — model has no reasoning step; setThink(true)  returns ok:false
//   'unknown'    — runner can't tell; setThink is a best-effort no-op
//
// Reasoning visibility:
//   - Runners SHOULD strip in-band reasoning tokens (e.g. <think>...</think>)
//     from the streamed text when think is off.
//   - When think is on, runners MAY pass them through as plain text for
//     now. A future revision can route reasoning through a separate
//     channel (e.g. yield { type: 'thinking', text } objects), at which
//     point the renderer will need to learn the new shape.

const { OllamaRunner } = require('./ollama');

const REGISTRY = {
  ollama: OllamaRunner,
};

function createRunner(name = 'ollama', opts = {}) {
  const Cls = REGISTRY[name];
  if (!Cls) throw new Error(`unknown runner: ${name}`);
  return new Cls(opts);
}

module.exports = { createRunner, REGISTRY };
