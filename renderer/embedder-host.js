// Renderer-side embedder host. Lives in a hidden BrowserWindow whose
// only job is to run @huggingface/transformers — which can target
// WebGPU here but cannot in the Node/main process (onnxruntime-web
// is browser-only).
//
// Protocol with main (see electron/embedderBridge.js):
//   main → renderer:  { type: 'embed:request', id, text, opts }
//   renderer → main:  { type: 'embed:reply', id, ok, vector? | error? }
//   renderer → main:  { type: 'embed:status', payload }
//
// All wiring goes through window.embedderHost (exposed by
// electron/embedder-host-preload.js with contextIsolation:true).

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

// One pipeline per device. Lazy-built on the first embed request.
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
  transformersModule = await import('./vendor/transformers/transformers.web.js');
  const env = transformersModule.env;
  // Pull from the HF hub on first run, then use the in-renderer
  // disk cache. (No bundled local /models dir.)
  env.allowLocalModels = false;
  // Point the ONNX runtime at the vendored WASM file so the bundle
  // doesn't try to fetch it from a CDN (which our CSP would block).
  // The .mjs file we copied lives next to transformers.web.js.
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', window.location.href).toString();
  }
  return transformersModule;
}

// Detect WebGPU in the renderer. navigator.gpu is the standard probe.
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

// Resolve the user-requested device into one we can actually run.
// Mirrors the shape of src/core/embedder.js#resolveDevice but the
// availability check is real here (we have navigator.gpu).
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

async function getPipeline(device) {
  if (!pipelinePromises.has(device)) {
    const promise = (async () => {
      const { pipeline } = await loadTransformers();
      const opts = device === 'cpu' ? {} : { device };
      log(`loading ${MODEL_ID} on ${device}…`);
      const pipe = await pipeline('feature-extraction', MODEL_ID, opts);
      log(`ready: ${MODEL_ID} on ${device}`);
      return pipe;
    })();
    pipelinePromises.set(device, promise);
  }
  return pipelinePromises.get(device);
}

async function handleEmbed({ text, opts }) {
  const resolved = await resolveDevice(opts && opts.device);
  const pipe = await getPipeline(resolved.device);
  const out = await pipe(text || '', { pooling: 'mean', normalize: true });
  // Float32Array doesn't survive structuredClone via IPC the way we
  // want — convert to a plain array so the wrapper on the main side
  // can rehydrate to Float32Array consistently.
  const vector = Array.from(out.data);
  return { vector, dim: vector.length, resolvedDevice: resolved };
}

async function handleStatus() {
  const probe = await detectWebGPU();
  return {
    modelId: MODEL_ID,
    dim: DIM,
    supportedDevices: ['cpu', 'webgpu', 'auto'],
    defaultDevice: 'cpu',
    loadedDevices: [...pipelinePromises.keys()],
    webgpuRuntimeAvailable: probe.available,
    webgpuProbe: probe,
  };
}

// Bridge wiring. The preload script (electron/embedder-host-preload.js)
// exposes window.embedderHost = { onRequest(fn), reply(...) }.
if (!window.embedderHost) {
  log('FATAL: embedderHost bridge missing (preload not loaded?)');
} else {
  window.embedderHost.onRequest(async (msg) => {
    const { id, type, payload } = msg;
    try {
      if (type === 'embed') {
        const out = await handleEmbed(payload || {});
        window.embedderHost.reply({ id, ok: true, ...out });
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
  // Eagerly probe WebGPU + report initial status so main can paint
  // an honest "available?" badge without waiting for the first embed.
  handleStatus().then((s) => {
    window.embedderHost.reply({ id: '__init__', ok: true, status: s });
    log(`ready (WebGPU ${s.webgpuRuntimeAvailable ? 'available' : 'NOT available'})`);
  });
}
