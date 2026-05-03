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
    // Pull the actual limits so callers can decide whether a given
    // model will fit. The interesting ones for ML workloads:
    //   maxBufferSize                — biggest single GPUBuffer
    //   maxStorageBufferBindingSize  — biggest binding for a storage
    //                                  buffer in a single shader call
    // Models bigger than these limits will fail to load (or fall back
    // to CPU silently). MiB is the ergonomic unit for the UI.
    const limits = adapter.limits || {};
    let info = {};
    try { info = await adapter.requestAdapterInfo?.() || {}; } catch { /* older Chromium */ }
    return {
      available: true,
      adapter: info.vendor || info.architecture || 'gpu',
      info,
      limits: {
        maxBufferSize: Number(limits.maxBufferSize || 0),
        maxStorageBufferBindingSize: Number(limits.maxStorageBufferBindingSize || 0),
        maxBufferSizeMB: Math.round((Number(limits.maxBufferSize || 0)) / 1024 / 1024),
        maxStorageBufferBindingSizeMB: Math.round((Number(limits.maxStorageBufferBindingSize || 0)) / 1024 / 1024),
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
  // Sampling params chosen to suppress the degenerate-repeat failure
  // mode that small models (Qwen 0.5B in particular) fall into when
  // sampling is too greedy or temperature is too low. The penalty +
  // top_p combo is the standard recipe — suppress recently-seen
  // tokens, broaden the candidate pool. Caller can override any of
  // these via opts.
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

  // Streaming via TextStreamer. The library exports a streamer class
  // that calls a callback per detokenized chunk — we forward those
  // through the bridge as { chunk } messages. The pipeline's awaited
  // result is still the final text, used for the terminal reply.
  //
  // We also install a degeneracy stop: if the same short suffix
  // appears N times in a row in the cumulative text (Qwen 0.5B's
  // signature failure mode), the InterruptableStoppingCriteria
  // halts generation. Without this, the model can spin out 500
  // identical sentences inside max_new_tokens.
  let cumulative = '';
  let tokenCount = 0;
  let stoppedForRepetition = false;
  const tm = await loadTransformers();
  const stoppingCriteria = tm.InterruptableStoppingCriteria
    ? new tm.InterruptableStoppingCriteria()
    : null;
  if (stoppingCriteria) generationOpts.stopping_criteria = stoppingCriteria;

  // Detect a 4-word phrase repeating 3+ times back-to-back at the
  // tail of `cumulative`. Cheap to compute on every chunk and
  // catches the "Any other statement. Any other statement." pattern.
  function looksDegenerate(text) {
    if (text.length < 80) return false;
    const tail = text.slice(-200);
    // Strip whitespace differences so case + spacing don't hide the loop.
    const norm = tail.replace(/\s+/g, ' ').toLowerCase();
    // Try phrases of 3-8 words; if any appears 3+ times in the tail
    // it's a runaway loop.
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

  // Trim a degenerate tail. If the model fell into a loop, we cut
  // back to the last "good" sentence and tag the finishReason so
  // the caller can surface that to the user.
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

// Drop a degenerate-repeat tail: find the first occurrence of the
// looping phrase and cut everything after it.
function trimRepetitionTail(text) {
  for (let words = 3; words <= 8; words++) {
    const re = new RegExp(`(\\b(?:\\S+\\s+){${words - 1}}\\S+\\b)(?:\\s+\\1){2,}`, 'i');
    const m = text.match(re);
    if (!m) continue;
    const cut = text.indexOf(m[1]);
    if (cut < 20) continue;   // whole output is degenerate, nothing to keep
    return text.slice(0, cut + m[1].length).trim() + ' …';
  }
  return text;
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

// Files transformers.js v4 fetches per model. Most repos publish all
// of these; some omit tokenizer files when the parent embeds them in
// config.json. We treat the model file (under onnx/) as required and
// the rest as best-effort — a model with model_quantized.onnx but no
// tokenizer_config.json still loaded for some users.
const REQUIRED_FILES_BY_PIPELINE = {
  'feature-extraction': [
    { path: 'config.json', required: true },
    { path: 'tokenizer.json', required: true },
    { path: 'tokenizer_config.json', required: false },
    // Embedder bundle is small + unquantized; weight file name varies.
    { path: 'onnx/model.onnx', required: false },
    { path: 'onnx/model_quantized.onnx', required: false },
  ],
  'text-generation': [
    { path: 'config.json', required: true },
    { path: 'tokenizer.json', required: true },
    { path: 'tokenizer_config.json', required: false },
    { path: 'generation_config.json', required: false },
    { path: 'special_tokens_map.json', required: false },
    // ONNX weight file — name pattern depends on quantization.
    // Caller resolves the actual filename present in the cache.
    { path: 'onnx/model.onnx', required: false },
    { path: 'onnx/model_q4f16.onnx', required: false },
    { path: 'onnx/model_quantized.onnx', required: false },
    { path: 'onnx/decoder_model_merged.onnx', required: false },
    { path: 'onnx/decoder_model_merged_q4f16.onnx', required: false },
  ],
};

const HF_HOSTS = ['huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs.huggingface.co'];

// Build the set of HF URLs we expect for a given (repo, files).
// transformers.js stores each fetched file under a URL like
//   https://huggingface.co/<repo>/resolve/main/<path>
function expectedUrls(repo, files) {
  return files.map((f) => ({
    ...f,
    url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
  }));
}

// Open the transformers cache. The library uses the Cache API
// keyed by name 'transformers-cache' (v4 default). If the cache
// doesn't exist yet, we treat that as "no model is downloaded".
async function openTransformersCache() {
  if (!('caches' in self)) return null;
  try {
    const names = await caches.keys();
    // Cache name was 'transformers-cache' in v2, may differ in v4.
    // Match by prefix to be defensive.
    const match = names.find((n) => n === 'transformers-cache' || n.startsWith('transformers-'));
    if (!match) return null;
    return caches.open(match);
  } catch {
    return null;
  }
}

// Inspect the cache for a model. Returns:
//   { cached: bool, files: [{path, url, sizeBytes, found}],
//     totalBytes, sourceRepo, anyWeightFound, missingRequired: [...] }
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

  // For each expected URL, check the cache. The Cache API matches by
  // exact URL (or with `ignoreSearch`/`ignoreVary` opts), so we use
  // exact match — transformers stores by canonical URL.
  let totalBytes = 0;
  let anyWeightFound = false;
  const missingRequired = [];
  const fileResults = await Promise.all(expected.map(async (f) => {
    const res = await cache.match(f.url);
    let sizeBytes = 0;
    let found = false;
    if (res) {
      found = true;
      // Prefer the actual blob size (truthful) over content-length
      // header (cheap but sometimes missing on cached-from-CDN entries).
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

  // "Cached" means: every required file is present AND at least one
  // weight file is present. Loose enough to handle both quantized
  // and unquantized model variants without us hard-coding which.
  const cached = missingRequired.length === 0 && anyWeightFound;
  return {
    modelId, sourceRepo: entry.repo,
    cached, files: fileResults, totalBytes,
    anyWeightFound, missingRequired,
  };
}

// "Warm up" a model — build the pipeline (which downloads + loads
// it onto the chosen device) without running inference. Used by the
// pre-download button so the user can pay the cost deliberately
// instead of having it freeze the first inference call.
async function handleWarmup({ modelId, opts }) {
  const resolved = await resolveDevice(opts && opts.device);
  const t0 = performance.now();
  await getPipeline(modelId || DEFAULT_GENERATE_MODEL, resolved.device);
  const ms = Math.round(performance.now() - t0);
  return { modelId, resolvedDevice: resolved, loadMs: ms };
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
      } else if (type === 'cache-status') {
        const out = await handleCacheStatus(payload || {});
        window.embedderHost.reply({ id, ok: true, ...out });
      } else if (type === 'warmup') {
        const out = await handleWarmup(payload || {});
        window.embedderHost.reply({ id, ok: true, ...out });
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
