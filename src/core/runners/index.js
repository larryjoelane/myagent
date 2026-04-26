// Runner registry. Add new runners here (e.g., transformersJs) to enable
// the model-runner switch feature later. The Agent only depends on the
// shape: { health(), stream(messages, opts) }.

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
