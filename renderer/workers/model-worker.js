// @ts-check
// Model Worker — runs @huggingface/transformers (which uses
// onnxruntime-web under the hood) in a dedicated Web Worker. Owns
// model loading, embedding, and text generation. WebGPU-capable.
//
// Why a Worker instead of the renderer process: keeps WASM init,
// model load (~3s for MiniLM, much longer for Qwen), and inference
// off the chat-UI thread so PTY keystroke handling stays responsive.
// Singleton — every consumer of the in-process models (embed / generate)
// shares one instance via the model-bridge.
//
// Protocol with the renderer (see renderer/model-bridge.js):
//   in:  { id, type: 'embed'|'generate'|'status'|'cache-status'|'warmup', payload }
//   out: terminal: { id, ok, ... }
//        streaming: { id, chunk, done: false }
//
// Spawned as a module-type Worker so it can `import` the vendored
// transformers bundle. The vendored path is resolved relative to
// self.location, which is the worker script URL.

// Mirror of src/core/models/registry.js (kept in sync manually — the
// worker can't require() Node modules and we don't want to pump the
// registry through every IPC message).
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
  'qwen3-4b-q4': {
    repo: 'onnx-community/Qwen3-4B-ONNX',
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

function log(msg) {
  // eslint-disable-next-line no-console
  console.log('[model-worker]', msg);
}

async function loadTransformers() {
  if (transformersModule) return transformersModule;
  // Vendored at install time via scripts/copy-transformers.js. The
  // Worker is a module-type worker so dynamic import works; we
  // resolve relative to self.location (the worker script URL).
  transformersModule = await import('../vendor/transformers/transformers.web.bundle.mjs');
  const env = transformersModule.env;
  env.allowLocalModels = false;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', self.location.href).toString();
  }
  return transformersModule;
}

async function detectWebGPU() {
  if (!('gpu' in navigator)) return { available: false, reason: 'navigator.gpu missing' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false, reason: 'no GPUAdapter' };
    // adapter.info is the modern accessor (Chromium ≥122). The older
    // requestAdapterInfo() method was removed from the spec, so we
    // don't attempt it. Both vendor and architecture can be empty
    // strings on integrated GPUs — fall back to a generic label.
    const info = adapter.info;
    const limits = adapter.limits;
    const maxBufferSize = Number(limits.maxBufferSize || 0);
    const maxStorageBufferBindingSize = Number(limits.maxStorageBufferBindingSize || 0);
    return {
      available: true,
      adapter: info.vendor || info.architecture || 'gpu',
      info: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      },
      limits: {
        maxBufferSize,
        maxStorageBufferBindingSize,
        maxBufferSizeMB: Math.round(maxBufferSize / 1024 / 1024),
        maxStorageBufferBindingSizeMB: Math.round(maxStorageBufferBindingSize / 1024 / 1024),
      },
    };
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

async function handleGenerate({ prompt, opts }, sendChunk) {
  const modelId = (opts && opts.modelId) || DEFAULT_GENERATE_MODEL;
  const resolved = await resolveDevice(opts && opts.device);
  const { pipe, loadMs } = await getPipeline(modelId, resolved.device);

  const messages = [{ role: 'user', content: String(prompt || '') }];
  // Sampling chosen to suppress the degenerate-repeat failure mode that
  // small models (Qwen 0.5B in particular) fall into when sampling is
  // too greedy. The penalty + top_p combo is the standard recipe.
  const wantSampling = !(opts && opts.temperature === 0);
  const generationOpts = {
    max_new_tokens: Math.min(2048, Math.max(1, (opts && opts.maxTokens) || 256)),
    do_sample: wantSampling,
    temperature: (opts && opts.temperature) || 0.7,
    top_p: (opts && opts.topP) || 0.9,
    top_k: (opts && opts.topK) || 50,
    repetition_penalty: (opts && opts.repetitionPenalty) || 1.15,
    no_repeat_ngram_size: (opts && opts.noRepeatNgramSize) || 4,
    return_full_text: false,
  };

  let cumulative = '';
  let tokenCount = 0;
  let stoppedForRepetition = false;
  const tm = await loadTransformers();
  const stoppingCriteria = tm.InterruptableStoppingCriteria
    ? new tm.InterruptableStoppingCriteria()
    : null;
  if (stoppingCriteria) generationOpts.stopping_criteria = stoppingCriteria;

  // Detect a 4-word phrase repeating 3+ times back-to-back at the
  // tail of `cumulative`. Catches the "Any other statement. Any other
  // statement." pattern Qwen 0.5B sometimes produces.
  function looksDegenerate(text) {
    if (text.length < 80) return false;
    const tail = text.slice(-200);
    const norm = tail.replace(/\s+/g, ' ').toLowerCase();
    for (let words = 3; words <= 8; words++) {
      const re = new RegExp(`(\\b(?:\\S+\\s+){${words - 1}}\\S+\\b)(?:\\s+\\1){2,}`, 'i');
      if (re.test(norm)) return true;
    }
    return false;
  }

  if (opts && opts.stream) {
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
          if (!stoppedForRepetition && stoppingCriteria && looksDegenerate(cumulative)) {
            stoppedForRepetition = true;
            try { stoppingCriteria.interrupt(); } catch { /* ignore */ }
          }
        },
      });
      generationOpts.streamer = streamer;
    }
  }

  const t0 = performance.now();
  const result = await pipe(messages, generationOpts);
  const ms = Math.max(1, performance.now() - t0);

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
  if (usedCount === 0 && text) usedCount = Math.max(1, Math.round(text.length / 4));

  let finishReason = stoppedForRepetition ? 'repetition_stop' : 'stop';
  let finalText = text || cumulative;
  if (looksDegenerate(finalText)) {
    finishReason = 'repetition_stop';
    finalText = trimRepetitionTail(finalText);
  }

  const seconds = ms / 1000;
  return {
    text: finalText,
    tokensUsed: usedCount,
    tokensPerSec: +(usedCount / seconds).toFixed(2),
    modelLoadMs: loadMs,
    finishReason,
    resolvedDevice: resolved,
  };
}

function trimRepetitionTail(text) {
  for (let words = 3; words <= 8; words++) {
    const re = new RegExp(`(\\b(?:\\S+\\s+){${words - 1}}\\S+\\b)(?:\\s+\\1){2,}`, 'i');
    const m = text.match(re);
    if (!m) continue;
    const cut = text.indexOf(m[1]);
    if (cut < 20) continue;
    return text.slice(0, cut + m[1].length).trim() + ' …';
  }
  return text;
}

async function handleStatus() {
  const probe = await detectWebGPU();
  return {
    modelId: DEFAULT_EMBED_MODEL,
    dim: 384,
    supportedDevices: ['cpu', 'webgpu', 'auto'],
    defaultDevice: 'cpu',
    loadedPipelines: [...pipelinePromises.keys()],
    webgpuRuntimeAvailable: probe.available,
    webgpuProbe: probe,
  };
}

const REQUIRED_FILES_BY_PIPELINE = {
  'feature-extraction': [
    { path: 'config.json', required: true },
    { path: 'tokenizer.json', required: true },
    { path: 'tokenizer_config.json', required: false },
    { path: 'onnx/model.onnx', required: false },
    { path: 'onnx/model_quantized.onnx', required: false },
  ],
  'text-generation': [
    { path: 'config.json', required: true },
    { path: 'tokenizer.json', required: true },
    { path: 'tokenizer_config.json', required: false },
    { path: 'generation_config.json', required: false },
    { path: 'special_tokens_map.json', required: false },
    { path: 'onnx/model.onnx', required: false },
    { path: 'onnx/model_q4f16.onnx', required: false },
    { path: 'onnx/model_quantized.onnx', required: false },
    { path: 'onnx/decoder_model_merged.onnx', required: false },
    { path: 'onnx/decoder_model_merged_q4f16.onnx', required: false },
  ],
};

function expectedUrls(repo, files) {
  return files.map((f) => ({
    ...f,
    url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
  }));
}

async function openTransformersCache() {
  if (!('caches' in self)) return null;
  try {
    const names = await caches.keys();
    const match = names.find((n) => n === 'transformers-cache' || n.startsWith('transformers-'));
    if (!match) return null;
    return caches.open(match);
  } catch {
    return null;
  }
}

async function handleCacheStatus({ modelId }) {
  const entry = MODELS[modelId];
  if (!entry) throw new Error(`unknown model id: ${modelId}`);
  const fileSpecs = REQUIRED_FILES_BY_PIPELINE[entry.pipeline] || [];
  const expected = expectedUrls(entry.repo, fileSpecs);

  const cache = await openTransformersCache();
  if (!cache) {
    return {
      modelId, sourceRepo: entry.repo,
      cached: false,
      files: expected.map((f) => ({ ...f, sizeBytes: 0, found: false })),
      totalBytes: 0,
      anyWeightFound: false,
      missingRequired: expected.filter((f) => f.required).map((f) => f.path),
    };
  }

  let totalBytes = 0;
  let anyWeightFound = false;
  const missingRequired = [];
  const fileResults = await Promise.all(expected.map(async (f) => {
    const res = await cache.match(f.url);
    let sizeBytes = 0;
    let found = false;
    if (res) {
      found = true;
      try {
        const blob = await res.clone().blob();
        sizeBytes = blob.size;
      } catch {
        sizeBytes = Number(res.headers.get('content-length') || 0);
      }
    }
    if (found) totalBytes += sizeBytes;
    if (found && f.path.endsWith('.onnx')) anyWeightFound = true;
    if (!found && f.required) missingRequired.push(f.path);
    return { path: f.path, url: f.url, required: !!f.required, sizeBytes, found };
  }));

  const cached = missingRequired.length === 0 && anyWeightFound;
  return {
    modelId, sourceRepo: entry.repo,
    cached, files: fileResults, totalBytes,
    anyWeightFound, missingRequired,
  };
}

async function handleWarmup({ modelId, opts }) {
  const resolved = await resolveDevice(opts && opts.device);
  const t0 = performance.now();
  await getPipeline(modelId || DEFAULT_GENERATE_MODEL, resolved.device);
  const ms = Math.round(performance.now() - t0);
  return { modelId, resolvedDevice: resolved, loadMs: ms };
}

// --- Message dispatch -----------------------------------------------------

self.addEventListener('message', async (ev) => {
  const msg = ev.data || {};
  const { id, type, payload } = msg;
  try {
    if (type === 'embed') {
      const out = await handleEmbed(payload || {});
      self.postMessage({ id, ok: true, ...out });
    } else if (type === 'generate') {
      const sendChunk = (chunk) => self.postMessage({ id, chunk, done: false });
      const out = await handleGenerate(payload || {}, sendChunk);
      self.postMessage({ id, ok: true, done: true, ...out });
    } else if (type === 'status') {
      const out = await handleStatus();
      self.postMessage({ id, ok: true, status: out });
    } else if (type === 'cache-status') {
      const out = await handleCacheStatus(payload || {});
      self.postMessage({ id, ok: true, ...out });
    } else if (type === 'warmup') {
      const out = await handleWarmup(payload || {});
      self.postMessage({ id, ok: true, ...out });
    } else {
      self.postMessage({ id, ok: false, error: `unknown type "${type}"` });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
});

log('booted');
