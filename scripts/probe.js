// Standalone probe: replicates exactly what OllamaRunner.health() does,
// but in plain Node so we can isolate Electron-specific issues.
const { OllamaRunner } = require('../src/core/runners/ollama');

(async () => {
  const r = new OllamaRunner();
  console.log('host:', r.host);
  console.log('OLLAMA_HOST env:', process.env.OLLAMA_HOST || '(unset)');
  const t0 = Date.now();
  const h = await r.health({ timeoutMs: 5000 });
  console.log(`health (${Date.now() - t0}ms):`, h);
})();
