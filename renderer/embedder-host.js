// Renderer-side model host. Lives in a hidden BrowserWindow whose
// only job is to run @huggingface/transformers — which can target
// WebGPU here but cannot in the Node/main process (onnxruntime-web
// is browser-only).
//
// Despite the name (legacy from when this only handled embeddings),
// this also runs text-generation models. The embedder bridge IPC
// names ('embedder:request', etc.) are kept for backwards compat.
//
// Protocol with main (see src/core/embedderBridge.js):
//   main → renderer:  { id, type: 'embed'|'generate'|'status', payload }
//   renderer → main:  terminal: { id, ok, ... }  (resolves the request)
//                     streaming: { id, chunk, done: false }  (intermediate)
//
// All wiring goes through window.embedderHost (exposed by
// electron/embedder-host-preload.js with contextIsolation:true).

// In-renderer mirror of src/core/models/registry.js. Kept as a flat
// table here because the host can't require() Node modules and we
// don't want to ship the registry through every IPC message. Update
// both files together when adding a model.
const MODELS = {
  'minilm-l6-v2': {
    repo: 'Xenova/all-MiniLM-L6-v2',
    pipeline: 'feature-extraction',
    quantization: null,
  },
  'qwen2.5-0.5b-q4': {
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    pipeline: 'text-generation',
    quantization: 'q4f16',
  },
};

const DEFAULT_EMBED_MODEL = 'minilm-l6-v2';
const DEFAULT_GENERATE_MODEL = 'qwen2.5-0.5b-q4';

// pipeline-cache key: `${modelId}::${device}`. Lazy: built on first
// request that names the model. Surviving across requests is what
// lets the second embed/generate land fast.
const pipelinePromises = new Map();
let transformersModule = null;

const statusEl = document.getElementById('status');
function log(msg) {
  if (statusEl) statusEl.textContent = msg;
  // eslint-disable-next-line no-console
  console.log('[embedder-host]', msg);
}

async function loadTransformers() {
  if (transformersModule) return transformersModule;
  // Vendored at install time via scripts/copy-transformers.js. We
  // can't use bare-name imports under file:// — the renderer has no
  // module resolution for node_modules.
  transformersModule = await import('./vendor/transformers/transformers.web.bundle.mjs');
  const env = transformersModule.env;
  env.allowLocalModels = false;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', window.location.href).toString();
  }
  return transformersModule;
}

async function detectWebGPU() {
  if (!('gpu' in navigator)) return { available: false, reason: 'navigator.gpu missing' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false, reason: 'no GPUAdapter' };
    return { available: true, adapter: adapter.name || 'gpu' };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

async function resolveDevice(requested) {
  const want = String(requested || 'cpu').toLowerCase();
  if (want === 'cpu') return { device: 'cpu', requested: 'cpu', fallback: false };
  const probe = await detectWebGPU();
  if (want === 'webgpu') {
    if (!probe.available) {
      return { device: 'cpu', requested: 'webgpu', fallback: true,
        reason: `WebGPU unavailable: ${probe.reason}` };
    }
    return { device: 'webgpu', requested: 'webgpu', fallback: false };
  }
  if (want === 'auto') {
    return probe.available
      ? { device: 'webgpu', requested: 'auto', fallback: false }
      : { device: 'cpu', requested: 'auto', fallback: true,
          reason: `WebGPU unavailable: ${probe.reason}` };
  }
  return { device: 'cpu', requested: want, fallback: true,
    reason: `unknown device "${requested}"; using cpu` };
}

// Build (or reuse) a pipeline for (modelId, device). The transformers
// `pipeline()` factory takes the task name + repo + opts; we also pass
// `dtype` when the model entry declares a quantization preference (Qwen
// q4f16 is dramatically smaller than fp16).
async function getPipeline(modelId, device) {
  const key = `${modelId}::${device}`;
  if (pipelinePromises.has(key)) return pipelinePromises.get(key);
  const entry = MODELS[modelId];
  if (!entry) throw new Error(`unknown model id: ${modelId}`);

  const promise = (async () => {
    const { pipeline } = await loadTransformers();
    const opts = {};
    if (device !== 'cpu') opts.device = device;
    if (entry.quantization) opts.dtype = entry.quantization;
    const t0 = performance.now();
    log(`loading ${entry.repo} on ${device}…`);
    const pipe = await pipeline(entry.pipeline, entry.repo, opts);
    const ms = Math.round(performance.now() - t0);
    log(`ready: ${entry.repo} on ${device} (${ms}ms)`);
    return { pipe, loadMs: ms };
  })();
  pipelinePromises.set(key, promise);
  return promise;
}

async function handleEmbed({ text, opts }) {
  const modelId = (opts && opts.modelId) || DEFAULT_EMBED_MODEL;
  const resolved = await resolveDevice(opts && opts.device);
  const { pipe } = await getPipeline(modelId, resolved.device);
  const out = await pipe(text || '', { pooling: 'mean', normalize: true });
  return {
    vector: Array.from(out.data),
    dim: out.data.length,
    resolvedDevice: resolved,
  };
}

// Generate text. When opts.stream is true, intermediate tokens
// fire as { id, chunk: { token, cumulativeText, index }, done: false }
// messages via the bridge protocol; the terminal reply still carries
// the full text + tokens/sec.
async function handleGenerate({ prompt, opts }, sendChunk) {
  const modelId = (opts && opts.modelId) || DEFAULT_GENERATE_MODEL;
  const resolved = await resolveDevice(opts && opts.device);
  const { pipe, loadMs } = await getPipeline(modelId, resolved.device);

  const messages = [{ role: 'user', content: String(prompt || '') }];
  const generationOpts = {
    max_new_tokens: Math.min(2048, Math.max(1, (opts && opts.maxTokens) || 256)),
    do_sample: !!(opts && (opts.temperature ?? 0) > 0),
    temperature: (opts && opts.temperature) || 0.7,
    return_full_text: false,
  };

  // Streaming via TextStreamer. The library exports a streamer class
  // that calls a callback per detokenized chunk — we forward those
  // through the bridge as { chunk } messages. The pipeline's awaited
  // result is still the final text, used for the terminal reply.
  let cumulative = '';
  let tokenCount = 0;
  if (opts && opts.stream) {
    const tm = await loadTransformers();
    const Streamer = tm.TextStreamer;
    if (Streamer) {
      const streamer = new Streamer(pipe.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text) => {
          if (!text) return;
          cumulative += text;
          tokenCount += 1;
          if (typeof sendChunk === 'function') {
            sendChunk({ token: text, cumulativeText: cumulative, index: tokenCount });
          }
        },
      });
      generationOpts.streamer = streamer;
    }
  }

  const t0 = performance.now();
  const result = await pipe(messages, generationOpts);
  const ms = Math.max(1, performance.now() - t0);

  // Result shape varies a bit by version: array of {generated_text}
  // for chat-format inputs, where generated_text can be the assistant
  // turn (object) or a string. Normalize to a plain string.
  let text = '';
  let usedCount = tokenCount;
  if (Array.isArray(result) && result[0]) {
    const r = result[0];
    if (typeof r.generated_text === 'string') text = r.generated_text;
    else if (Array.isArray(r.generated_text)) {
      const lastTurn = r.generated_text[r.generated_text.length - 1];
      text = (lastTurn && lastTurn.content) || '';
    }
  } else if (typeof result === 'string') {
    text = result;
  }
  // If we never streamed, estimate token count from the output text
  // length / approx-chars-per-token. Crude but only used for tok/s.
  if (usedCount === 0 && text) usedCount = Math.max(1, Math.round(text.length / 4));

  const seconds = ms / 1000;
  return {
    text: text || cumulative,
    tokensUsed: usedCount,
    tokensPerSec: +(usedCount / seconds).toFixed(2),
    modelLoadMs: loadMs,
    finishReason: 'stop',
    resolvedDevice: resolved,
  };
}

async function handleStatus() {
  const probe = await detectWebGPU();
  return {
    modelId: DEFAULT_EMBED_MODEL,                  // legacy field — embedder default
    dim: 384,                                       // legacy field — MiniLM dim
    supportedDevices: ['cpu', 'webgpu', 'auto'],
    defaultDevice: 'cpu',
    loadedPipelines: [...pipelinePromises.keys()],
    webgpuRuntimeAvailable: probe.available,
    webgpuProbe: probe,
  };
}

// Bridge wiring.
if (!window.embedderHost) {
  log('FATAL: embedderHost bridge missing (preload not loaded?)');
} else {
  window.embedderHost.onRequest(async (msg) => {
    const { id, type, payload } = msg;
    try {
      if (type === 'embed') {
        const out = await handleEmbed(payload || {});
        window.embedderHost.reply({ id, ok: true, ...out });
      } else if (type === 'generate') {
        const sendChunk = (chunk) => window.embedderHost.reply({ id, chunk, done: false });
        const out = await handleGenerate(payload || {}, sendChunk);
        window.embedderHost.reply({ id, ok: true, done: true, ...out });
      } else if (type === 'status') {
        const out = await handleStatus();
        window.embedderHost.reply({ id, ok: true, status: out });
      } else {
        window.embedderHost.reply({ id, ok: false, error: `unknown type "${type}"` });
      }
    } catch (err) {
      window.embedderHost.reply({ id, ok: false, error: err.message });
    }
  });
  handleStatus().then((s) => {
    window.embedderHost.reply({ id: '__init__', ok: true, status: s });
    log(`ready (WebGPU ${s.webgpuRuntimeAvailable ? 'available' : 'NOT available'})`);
  });
}
